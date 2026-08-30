/**
 * Dragoman's own vocabulary — the small data shapes the bridge passes around,
 * independent of both wire protocols (Codex's app-server and MCP). The generated
 * Codex types live under generated/codex-protocol/; these are ours.
 */

import type { CommandExecutionStatus } from "../generated/codex-protocol/ts/v2/CommandExecutionStatus.ts";
import type { PatchApplyStatus } from "../generated/codex-protocol/ts/v2/PatchApplyStatus.ts";
import type { McpToolCallStatus } from "../generated/codex-protocol/ts/v2/McpToolCallStatus.ts";
import type { TurnStatus } from "../generated/codex-protocol/ts/v2/TurnStatus.ts";

/**
 * One entry in a run's single timeline — the unified, STRUCTURED event log.
 *
 * Everything a run tells the caller is ONE of these, regardless of which inbound
 * channel produced it: a tool milestone from the notification feed, an approval
 * raised/resolved by the server-request handler, a note from Codex, or the
 * terminal outcome. All producers `append` a `RunEvent`; `codex_status` drains
 * the log and returns the events verbatim as `structuredContent` — so a new
 * source can never reintroduce the "we dropped that one" bug (exactly one place
 * state is kept), and the DRIVING AGENT reads typed fields, not a prose line it
 * has to parse (docs/archive/peer-agent-lifecycle.md: the back-channel table).
 *
 * The design rule: a field the source already separated (a file path, an exit
 * code, a tool name) stays its own field here — we never re-flatten it into a
 * sentence. The ONLY free text is `message.text`: Codex's own words, which are
 * prose by nature. Everything Codex measured or named is structured.
 *
 * `kind` is the discriminant. `at` is when the source emitted it (ms) or our
 * clock. The rest is per-kind:
 *
 *  - `command`  a shell command, `running` on start / `ran` on completion,
 *               with the exit code and duration once known.
 *  - `edit`     a file patch: each file by path + change kind (add/delete/update).
 *  - `webSearch` a web search, carrying the query and action Codex ran.
 *  - `mcpTool`  an MCP tool call: server, tool, status, and any error.
 *  - `plan`     Codex's plan text for the turn.
 *  - `autoApproval` the guardian auto-deciding (no human), with risk + action.
 *  - `approval` a HUMAN approval lifecycle: `waiting` when parked, `resolved`
 *               with the decision once answered.
 *  - `message`  Codex's own words mid-run — the one free-text kind — with the
 *               source's `phase` (commentary vs. final_answer) when it gave one.
 *  - `result`   the terminal success outcome: the final message, turn status,
 *               and total duration.
 *  - `error`    the terminal failure: message and any extra detail.
 */
export type RunEvent =
  | { readonly kind: "command"; readonly at: number; readonly phase: "running" | "ran"; readonly command: string; readonly status: CommandExecutionStatus; readonly exitCode?: number; readonly durationMs?: number }
  | { readonly kind: "edit"; readonly at: number; readonly files: readonly { readonly path: string; readonly change: "add" | "delete" | "update" }[]; readonly status: PatchApplyStatus }
  | { readonly kind: "webSearch"; readonly at: number; readonly query?: string; readonly action?: "search" | "openPage" | "findInPage" | "other" }
  | { readonly kind: "mcpTool"; readonly at: number; readonly server: string; readonly tool: string; readonly status: McpToolCallStatus; readonly durationMs?: number; readonly error?: string }
  | { readonly kind: "plan"; readonly at: number; readonly text: string }
  | { readonly kind: "autoApproval"; readonly at: number; readonly decision: string; readonly risk?: string; readonly action: string }
  | { readonly kind: "approval"; readonly at: number; readonly phase: "waiting" | "resolved"; readonly what: string; readonly decision?: string }
  | { readonly kind: "message"; readonly at: number; readonly text: string; readonly phase?: "commentary" | "final_answer" }
  | { readonly kind: "result"; readonly at: number; readonly status: TurnStatus; readonly text?: string; readonly durationMs?: number }
  | { readonly kind: "error"; readonly at: number; readonly message: string; readonly details?: string };

/**
 * A run's usage snapshot, every field a PERCENTAGE USED (0–100), rounded.
 *
 * Deliberately not token counts: the driving agent wants "how close am I to a
 * wall", not "61k of 250k". Two of these are account-global (the rate-limit
 * windows, shared across every run and merged from the sparse
 * `account/rateLimits/updated` feed); `ctx` is per-run (this thread's context
 * occupancy from `thread/tokenUsage/updated`). `codex_status` composes all three.
 */
export interface RunUsage {
  /** % of the short (5-hour) rate-limit window used. */
  readonly "5h"?: number;
  /** % of the weekly rate-limit window used. */
  readonly "7d"?: number;
  /** % of this thread's model context window used. */
  readonly ctx?: number;
}

/** Opaque handle `codex_run` returns and `codex_status` takes. Currently a thread id. */
export type RunHandle = string;

/**
 * Where a run is in its lifecycle, as `codex_status` reports it.
 *
 * `waiting-approval` is the state that makes this whole project exist: Codex has
 * asked to do something the mirrored policy can't auto-answer, an elicitation is
 * in front of the user, and the run is parked — not hung — until they respond.
 */
export type RunStatus = "starting" | "running" | "waiting-approval" | "done" | "error";

/**
 * The bridge's live record of one Codex run.
 *
 * The background pump mutates this as notifications arrive; `codex_status` reads
 * it with no I/O at all. Two kinds of state, deliberately separated:
 *
 *  - `status` — the persistent CONTROL scalar (latest-wins, safe to overwrite): the
 *    O(1) "is it running / waiting / done?" the long-poll needs to decide whether to
 *    park and the caller needs to decide whether to stop.
 *  - `events` — the append-only MESSAGE log (never overwritten, drained once): every
 *    milestone, approval, note and terminal outcome, from every inbound channel, in
 *    order. This is the single place run output is kept, so no source can drop
 *    another's message at the polling boundary. The firehose between milestones is
 *    still dropped by construction (never becomes an event).
 */
export interface RunRecord {
  readonly handle: RunHandle;
  /** The working directory the run was started in. Retained so `codex_continue`
   * can resume the thread and re-mirror against the same cwd + writable roots. */
  readonly cwd?: string;
  /** Command token prefixes Claude would allow without prompting. */
  readonly execpolicyAmendments?: readonly (readonly string[])[];
  /** Command token prefixes Claude would deny — pre-declined without prompting. */
  readonly denyPrefixes?: readonly (readonly string[])[];
  /** What to do with a command approval no allow/deny prefix settles: ask the human
   * (`elicit`, default) or refuse without asking (`decline`, for `dontAsk`). */
  readonly commandFallback?: "elicit" | "decline";
  /** What to do with a file-edit approval: ask (`elicit`), auto-approve (`accept`,
   * for `acceptEdits`), or refuse (`decline`, for `dontAsk`). */
  readonly fileChange?: "elicit" | "accept" | "decline";
  status: RunStatus;
  /** This thread's context-window occupancy, as a percentage used (0–100), from
   * the latest `thread/tokenUsage/updated`. Latest-wins telemetry (like `status`),
   * not part of the event log; `codex_status` folds it into `RunUsage.ctx`. */
  ctx?: number;
  /** The active turn's id (Codex UUIDv7), refreshed on every `turn/started`.
   * The precondition `turn/interrupt` and `turn/steer` both require — captured
   * here so a cancel/steer/continue tool can name the turn without a round-trip —
   * and surfaced by `diagnostics` as the live view of what each run is doing. */
  turnId?: string;
  /** The single append-only timeline (see the type doc): every producer appends, and
   * `codex_status` drains it in order. The terminal outcome is the last event of kind
   * `result`/`error` — not a special field — so nothing here is delivered specially. */
  events: RunEvent[];
}
