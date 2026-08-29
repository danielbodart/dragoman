/**
 * The Claude Code edge: a stdio MCP server exposing the two tools.
 *
 * Built on `@modelcontextprotocol/sdk`'s low-level `Server` (not the `McpServer`
 * sugar) for one reason: `Server.elicitInput()` is callable at any time after
 * connect, detached from any tool-call handler — which is exactly what the async
 * approval needs (the pump fires an elicitation from its own loop, not from
 * inside a `codex_run` call). The SDK is the one runtime dependency; it is kept
 * behind this file and `McpElicitationChannel`, so nothing else imports it.
 *
 * Both tools are fast and touch only in-memory run state, so they return well
 * inside Claude Code's ~120s tool-call ceiling.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { diagnostics } from "./diagnostics.ts";
import { samplingProbe } from "./sampling-probe.ts";
import type { ThreadRuns } from "./thread-run.ts";
import { version } from "./version.ts";

/**
 * Build the MCP server and register the tools against a run registry.
 *
 * Returns the `Server` so the caller can build the `ElicitationChannel` over it
 * and then `serve()` it.
 */
export function buildServer(runs: ThreadRuns): Server {
  // `elicitation` is a CLIENT capability (Claude Code advertises it so the
  // server may send elicitation/create); the server only declares `tools`.
  const server = new Server(
    { name: "dragoman", version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    switch (name) {
      case "codex_run":
        return text(await runCodex(runs, args ?? {}));
      case "codex_status":
        return text(await statusCodex(runs, args ?? {}));
      case "diagnostics":
        return text(diagnostics());
      case "sampling_probe":
        return text(await samplingProbe(server));
      default:
        return text(`unknown tool: ${name}`, true);
    }
  });

  return server;
}

/**
 * Attach the stdio transport and run until Claude Code closes the pipe.
 *
 * `server.connect()` resolves once the transport is wired, NOT when it ends — so
 * awaiting only that would let `main()` fall through and the process exit
 * immediately. We wire the transport's `onclose` to a promise and await THAT, so
 * the server stays alive for the life of the stdio connection (until Claude Code
 * closes stdin).
 */
export async function serve(server: Server): Promise<void> {
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
    // Belt-and-braces: if Claude Code closes the pipe (stdin EOF) rather than
    // signalling, end the server too so main() can tear down and the process exit.
    process.stdin.on("close", resolve);
    process.stdin.on("end", resolve);
  });
  await server.connect(transport);
  await closed;
}

const TOOLS = [
  {
    name: "codex_run",
    description:
      "Start an OpenAI Codex task in the background and return a handle immediately. " +
      "Poll codex_status with the handle to follow progress; approvals surface as native prompts.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What Codex should do." },
        cwd: { type: "string", description: "Working directory for the task (absolute path)." },
        posture: {
          type: "string",
          enum: ["plan", "default", "acceptEdits", "auto", "dontAsk", "bypassPermissions"],
          description:
            "OPTIONAL — normally OMIT this. When omitted, Dragoman automatically mirrors " +
            "Claude's own live permission posture onto Codex, so Codex gets exactly the same " +
            "access you have. That auto-mirroring is the whole point; passing a value OVERRIDES " +
            "it with a fixed mode and will usually make Codex more restricted (or more permissive) " +
            "than Claude actually is. Only pass a value when the user explicitly asks Codex to run " +
            "in a specific mode (e.g. 'run Codex read-only' → 'plan'). Do NOT set it just because " +
            "you think you know your current mode — leave it unset and let Dragoman read the real one.",
        },
      },
      required: ["prompt", "cwd"],
    },
  },
  {
    // TEMPORARY: reports what the MCP subprocess actually sees at runtime, to
    // ground the settings-mirroring design in real data (cwd? which CLAUDE_*
    // env? which settings files reachable?) rather than assumptions. Remove once
    // the mirroring transport is settled.
    name: "diagnostics",
    description: "Diagnostic: report Dragoman's runtime environment (working directory, Claude Code env vars, reachable settings files). Used to design settings mirroring.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    // TEMPORARY: probe whether the MCP client (Claude Code) answers a
    // server-issued sampling request — and whether `auto` mode can do so without
    // a human. Linchpin for routing Codex approvals back to Claude's own model.
    // Remove once the approval-routing design is settled.
    name: "sampling_probe",
    description: "Diagnostic: test whether this MCP client answers server-issued sampling (createMessage) requests, plain and tools-enabled. Used to design approval routing.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "codex_status",
    description: "Check a Codex task started with codex_run: its status, the latest progress line, and the result when done.",
    inputSchema: {
      type: "object",
      properties: { handle: { type: "string", description: "The handle codex_run returned." } },
      required: ["handle"],
    },
  },
] as const;

async function runCodex(runs: ThreadRuns, args: Record<string, unknown>): Promise<string> {
  const prompt = String(args.prompt ?? "");
  const cwd = String(args.cwd ?? "");
  const posture = typeof args.posture === "string" ? args.posture : undefined;
  if (!prompt || !cwd) return "codex_run needs both `prompt` and `cwd`.";
  const handle = await runs.start(prompt, cwd, posture);
  return `Started Codex task. Poll codex_status with handle "${handle}".`;
}

/** How long a single codex_status call blocks waiting for progress, before it
 * returns "still running" so the caller can poll again — kept under Claude Code's
 * ~120s tool-call ceiling. */
const STATUS_LONGPOLL_MS = 100_000;

async function statusCodex(runs: ThreadRuns, args: Record<string, unknown>): Promise<string> {
  const handle = String(args.handle ?? "");
  if (!runs.status(handle)) return `No Codex task with handle "${handle}".`;

  // Long-poll: block until the run advances past its current revision (or is
  // already terminal), so this returns the instant Codex makes progress rather
  // than on a fixed interval. Times out to a "still running" line the caller
  // re-polls, staying under the tool-call ceiling.
  const since = runs.revision(handle);
  const { snapshot } = await runs.waitForUpdate(handle, since, STATUS_LONGPOLL_MS);
  const run = snapshot ?? runs.status(handle);
  if (!run) return `No Codex task with handle "${handle}".`;

  const beat = run.latestBeat ? ` — ${run.latestBeat.text}` : "";
  switch (run.status) {
    case "starting":
    case "running":
      return `Running${beat}.`;
    case "waiting-approval":
      return `Waiting for your approval${beat}.`;
    case "done":
      return `Done. ${run.result ?? "(no result text)"}`;
    case "error":
      return `Errored: ${run.error ?? "unknown error"}.`;
  }
}

/** Wrap a string as an MCP tool result. */
function text(value: string, isError = false): { content: { type: "text"; text: string }[]; isError?: boolean } {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}
