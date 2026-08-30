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
import type { ThreadRuns } from "./thread-run.ts";
import type { RunEvent, RunStatus, RunUsage } from "./model.ts";
import type { ReviewTarget } from "../generated/codex-protocol/ts/v2/ReviewTarget.ts";
import { version } from "./version.ts";

/**
 * A `codex_status` payload — the run's live state as STRUCTURED data, returned
 * verbatim as `structuredContent`. `events` are the milestones drained this poll
 * (typed, never a prose line the caller has to parse); `usage` is the percentage
 * snapshot (5h / weekly rate-limit windows + this thread's context occupancy).
 */
export interface StatusResult {
  readonly handle: string;
  readonly status: RunStatus;
  readonly usage: RunUsage;
  readonly events: readonly RunEvent[];
}

/** An acknowledgement for the action tools (run/steer/cancel/continue/review):
 * the handle to poll plus a one-line human message. */
interface AckResult {
  readonly handle?: string;
  readonly message: string;
}

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
        return result(await runCodex(runs, args ?? {}));
      case "codex_status":
        return result(await statusCodex(runs, args ?? {}));
      case "codex_steer":
        return result(await steerCodex(runs, args ?? {}));
      case "codex_cancel":
        return result(await cancelCodex(runs, args ?? {}));
      case "codex_continue":
        return result(await continueCodex(runs, args ?? {}));
      case "codex_review":
        return result(await reviewCodex(runs, args ?? {}));
      case "diagnostics":
        return result({ report: diagnostics(runs) });
      default:
        return result({ error: `unknown tool: ${name}` }, true);
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

/**
 * A permissive output schema declared on every tool. Its presence is what makes a
 * client surface `structuredContent` (verified empirically against Claude Code);
 * it intentionally constrains nothing — each tool's real shape is its TS type
 * (`StatusResult` / `AckResult` / the diagnostics report), and the payload always
 * reaches the model as structuredContent regardless of the individual fields.
 */
const STRUCTURED_OUTPUT = { type: "object" } as const;

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
    outputSchema: STRUCTURED_OUTPUT,
  },
  {
    // Dragoman's ground-truth observability probe: what the MCP subprocess
    // actually sees (cwd, CLAUDE_* env, reachable settings, the mirror preview)
    // AND what it is doing right now (live runs + their active turns). Permanent
    // — the single operator view as the tool surface grows.
    name: "diagnostics",
    description:
      "Report Dragoman's runtime state: live Codex runs (status, active turn, latest milestone), the working directory, Claude Code env vars, reachable settings files, and the mirror preview (what those settings would apply to Codex per posture). Use it to see what a run is doing or why a mirror resolved as it did.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: STRUCTURED_OUTPUT,
  },
  {
    name: "codex_status",
    description: "Check a Codex task started with codex_run: its status, the latest progress line, and the result when done.",
    inputSchema: {
      type: "object",
      properties: { handle: { type: "string", description: "The handle codex_run returned." } },
      required: ["handle"],
    },
    outputSchema: STRUCTURED_OUTPUT,
  },
  {
    name: "codex_steer",
    description:
      "Send guidance to a RUNNING Codex task without interrupting it — the way you'd type a message while an agent works. " +
      "Use it to nudge, add a constraint, or redirect focus mid-turn (e.g. 'also check the Windows path'). " +
      "The task keeps its context and carries on; poll codex_status to see the steer take effect.",
    inputSchema: {
      type: "object",
      properties: {
        handle: { type: "string", description: "The handle codex_run returned." },
        text: { type: "string", description: "The guidance to inject into the running turn." },
      },
      required: ["handle", "text"],
    },
    outputSchema: STRUCTURED_OUTPUT,
  },
  {
    name: "codex_cancel",
    description:
      "Stop a RUNNING Codex task — the equivalent of pressing Esc. Use it when the task has gone off the rails or is no longer needed. " +
      "Returns immediately; poll codex_status to confirm it stopped. To redirect rather than stop, prefer codex_steer.",
    inputSchema: {
      type: "object",
      properties: { handle: { type: "string", description: "The handle codex_run returned." } },
      required: ["handle"],
    },
    outputSchema: STRUCTURED_OUTPUT,
  },
  {
    name: "codex_review",
    description:
      "Run Codex's dedicated code-review pass over a diff and return a handle immediately; poll codex_status for the findings. " +
      "Codex computes the diff itself and returns a prioritized, file:line-anchored review (P1/P2/… findings) — its own first-class review, " +
      "not a freeform prompt. By default reviews the UNCOMMITTED changes in `cwd`. Prefer this over codex_run for a code review.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Working directory of the repo to review (absolute path)." },
        against: {
          type: "string",
          description:
            "OPTIONAL base branch or ref to review the changes against (e.g. \"main\"). Omit to review the uncommitted changes.",
        },
        instructions: {
          type: "string",
          description:
            "OPTIONAL custom review focus (e.g. \"focus on error handling and edge cases\"). When set, Codex runs a custom review with these instructions instead of a plain diff review.",
        },
        posture: {
          type: "string",
          enum: ["plan", "default", "acceptEdits", "auto", "dontAsk", "bypassPermissions"],
          description:
            "OPTIONAL — normally OMIT. As with codex_run, Dragoman mirrors Claude's live posture; only pass a value when the user explicitly asks for a specific mode.",
        },
      },
      required: ["cwd"],
    },
    outputSchema: STRUCTURED_OUTPUT,
  },
  {
    name: "codex_continue",
    description:
      "Continue a FINISHED Codex task with a follow-up, on the same thread — so Codex keeps everything it learned instead of starting cold. " +
      "Use it for the natural next step ('now update the tests', 'also handle the empty case'). " +
      "The follow-up re-reads your CURRENT permission mode and settings, so it runs under the access you have now. " +
      "Reuses the original handle; poll codex_status with it as usual. (For a task still running, use codex_steer.)",
    inputSchema: {
      type: "object",
      properties: {
        handle: { type: "string", description: "The handle of the finished task to continue." },
        prompt: { type: "string", description: "The follow-up for Codex to do next on the same thread." },
        posture: {
          type: "string",
          enum: ["plan", "default", "acceptEdits", "auto", "dontAsk", "bypassPermissions"],
          description:
            "OPTIONAL — normally OMIT. As with codex_run, Dragoman mirrors Claude's live posture onto the continuation by default; " +
            "only pass a value when the user explicitly asks for a specific mode.",
        },
      },
      required: ["handle", "prompt"],
    },
    outputSchema: STRUCTURED_OUTPUT,
  },
] as const;

async function runCodex(runs: ThreadRuns, args: Record<string, unknown>): Promise<AckResult> {
  const prompt = String(args.prompt ?? "");
  const cwd = String(args.cwd ?? "");
  const posture = typeof args.posture === "string" ? args.posture : undefined;
  if (!prompt || !cwd) return { message: "codex_run needs both `prompt` and `cwd`." };
  const handle = await runs.start(prompt, cwd, posture);
  return { handle, message: `Started Codex task. Poll codex_status with handle "${handle}".` };
}

async function steerCodex(runs: ThreadRuns, args: Record<string, unknown>): Promise<AckResult> {
  const handle = String(args.handle ?? "");
  const text = String(args.text ?? "");
  if (!handle || !text) return { message: "codex_steer needs both `handle` and `text`." };
  return { handle, message: await runs.steer(handle, text) };
}

async function cancelCodex(runs: ThreadRuns, args: Record<string, unknown>): Promise<AckResult> {
  const handle = String(args.handle ?? "");
  if (!handle) return { message: "codex_cancel needs a `handle`." };
  return { handle, message: await runs.cancel(handle) };
}

async function continueCodex(runs: ThreadRuns, args: Record<string, unknown>): Promise<AckResult> {
  const handle = String(args.handle ?? "");
  const prompt = String(args.prompt ?? "");
  const posture = typeof args.posture === "string" ? args.posture : undefined;
  if (!handle || !prompt) return { message: "codex_continue needs both `handle` and `prompt`." };
  return { handle, message: await runs.continueRun(handle, prompt, posture) };
}

async function reviewCodex(runs: ThreadRuns, args: Record<string, unknown>): Promise<AckResult> {
  const cwd = String(args.cwd ?? "");
  if (!cwd) return { message: "codex_review needs a `cwd`." };
  const posture = typeof args.posture === "string" ? args.posture : undefined;
  const instructions = typeof args.instructions === "string" && args.instructions ? args.instructions : undefined;
  const against = typeof args.against === "string" && args.against ? args.against : undefined;
  // A custom focus wins; else diff against a named base; else the uncommitted changes.
  const target: ReviewTarget = instructions
    ? { type: "custom", instructions }
    : against
      ? { type: "baseBranch", branch: against }
      : { type: "uncommittedChanges" };
  const handle = await runs.review(cwd, target, posture);
  return { handle, message: `Started Codex review. Poll codex_status with handle "${handle}".` };
}

/** How long a single codex_status call blocks waiting for progress, before it returns
 * "still running" so the caller can poll again. It returns the INSTANT a beat lands
 * (event-driven wake), so this is only the cap for a quiet stretch — and it doubles as
 * the worst-case latency for a steer/cancel message reaching a subagent parked here (it
 * can only act once this call returns). 30s balances that against re-poll churn on a
 * fully-quiet run; well under Claude Code's ~120s tool-call ceiling. */
const STATUS_LONGPOLL_MS = 30_000;

async function statusCodex(runs: ThreadRuns, args: Record<string, unknown>): Promise<StatusResult | { error: string }> {
  const handle = String(args.handle ?? "");
  if (!runs.status(handle)) return { error: `No Codex task with handle "${handle}".` };

  // Long-poll unless there is already something undelivered: block until the run
  // advances past its current revision (or is terminal), so this returns the
  // instant Codex makes progress rather than on a fixed interval. If events are
  // already buffered we skip the wait and hand them over now — never leaving one
  // sitting until the next bump. Times out to a "still running" snapshot the caller
  // re-polls, staying under the tool-call ceiling.
  if (!runs.hasPending(handle)) {
    const since = runs.revision(handle);
    await runs.waitForUpdate(handle, since, STATUS_LONGPOLL_MS);
  }

  const run = runs.status(handle);
  if (!run) return { error: `No Codex task with handle "${handle}".` };

  // Drain the one timeline — every event (tool milestone, approval, Codex message,
  // terminal outcome), whatever its source, delivered exactly once, in order — and
  // hand it back as structured data alongside the run's status and usage snapshot.
  return { handle, status: run.status, usage: runs.usage(handle), events: runs.drain(handle) };
}

/**
 * Wrap a structured payload as an MCP tool result.
 *
 * Dragoman is 100% structured: the payload rides `structuredContent` (which
 * Claude Code surfaces to the model — verified empirically), and `content` carries
 * the SAME object serialized, only so the result stays a valid MCP frame and any
 * non-Claude client still receives the data. There is no separately-authored human
 * text: the struct is the single source of truth, and the serialized form is a
 * mechanical mirror of it, never a hand-maintained second rendering.
 */
function result(structured: object, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structured) }],
    structuredContent: structured as Record<string, unknown>,
    ...(isError ? { isError: true } : {}),
  };
}
