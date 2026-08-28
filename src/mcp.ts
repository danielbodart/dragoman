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
        return text(statusCodex(runs, args ?? {}));
      default:
        return text(`unknown tool: ${name}`, true);
    }
  });

  return server;
}

/** Attach the stdio transport and run until Claude Code closes the pipe. */
export async function serve(server: Server): Promise<void> {
  await server.connect(new StdioServerTransport());
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
      },
      required: ["prompt", "cwd"],
    },
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
  if (!prompt || !cwd) return "codex_run needs both `prompt` and `cwd`.";
  const handle = await runs.start(prompt, cwd);
  return `Started Codex task. Poll codex_status with handle "${handle}".`;
}

function statusCodex(runs: ThreadRuns, args: Record<string, unknown>): string {
  const handle = String(args.handle ?? "");
  const run = runs.status(handle);
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
