/**
 * The heartbeat filter (PLAN §6): the whole ~80-type notification firehose
 * collapsed to a sparse sequence of STRUCTURED events.
 *
 * `eventOf` is pure — `Notification → RunEvent | undefined` — so it is tested
 * against plain notification literals with no socket in sight, the same way
 * tidewaiter tests `toRunning`/`netBytesOf`. Anything not explicitly recognised
 * returns `undefined` and is dropped by the pump before it ever reaches a run's
 * timeline: that "match a milestone or drop it" shape is what enforces "coarse
 * and few" by construction, rather than by a filter the pump has to remember to
 * apply.
 *
 * It handles only the non-terminal, thread-scoped milestones (tool items + the
 * guardian's auto-approval). The terminal outcomes (`turn/completed`, `error`),
 * Codex's own `agentMessage`, and the human-approval lifecycle are folded in by
 * the pump itself, which owns run status and dedupe.
 */
import type { Notification } from "./codex.ts";
import type { RunEvent } from "./model.ts";
import type { ThreadItem } from "../generated/codex-protocol/ts/v2/ThreadItem.ts";
import type { ItemGuardianApprovalReviewCompletedNotification } from "../generated/codex-protocol/ts/v2/ItemGuardianApprovalReviewCompletedNotification.ts";
import type { GuardianApprovalReviewAction } from "../generated/codex-protocol/ts/v2/GuardianApprovalReviewAction.ts";
import type { FileUpdateChange } from "../generated/codex-protocol/ts/v2/FileUpdateChange.ts";
import type { WebSearchAction } from "../generated/codex-protocol/ts/v2/WebSearchAction.ts";

/** The `threadId` a notification concerns, or undefined for feed-wide (account/app/model) events. */
export function threadIdOf(notification: Notification): string | undefined {
  const params = notification.params as { threadId?: unknown };
  return typeof params.threadId === "string" ? params.threadId : undefined;
}

/**
 * A structured event for a notification, or undefined if it is not a milestone.
 *
 * Only a handful of the notification types produce an event; the rest — token and
 * reasoning deltas, raw response items, account/model housekeeping — are the
 * firehose, consumed and dropped.
 */
export function eventOf(notification: Notification): RunEvent | undefined {
  const at = notification.emittedAtMs ?? Date.now();

  switch (notification.method) {
    case "item/started":
      return itemEvent(notification.params.item, "start", at);
    case "item/completed":
      return itemEvent(notification.params.item, "done", at);
    case "item/autoApprovalReview/completed":
      return approvalEvent(notification.params, at);
    default:
      return undefined;
  }
}

/**
 * A structured event for a completed auto-approval review — Codex's internal
 * guardian deciding, without a human prompt, whether an action clears the sandbox
 * wall. Under `approvalPolicy: granular` these fire silently; surfacing the
 * decision (and what it was about) makes the otherwise-invisible auto-approval
 * visible, so a watcher sees *why* a run sailed past a command that would normally
 * prompt. `started`, `guardianWarning` (a redundant human summary of this same
 * decision) and `strictReviewRequired` are not milestones here.
 */
function approvalEvent(params: ItemGuardianApprovalReviewCompletedNotification, at: number): RunEvent {
  const { status, riskLevel } = params.review;
  return {
    kind: "autoApproval",
    at,
    decision: status,
    ...(riskLevel ? { risk: riskLevel } : {}),
    action: actionSummary(params.action),
  };
}

/** The files a patch touches, each as its own {path, change} — never re-flattened
 * into one string, so the driving agent can see add vs. delete vs. rename per file. */
function editFiles(changes: readonly FileUpdateChange[]): { path: string; change: "add" | "delete" | "update" }[] {
  return changes.map((c) => ({ path: c.path, change: c.kind.type }));
}

/** A short label for the action an auto-approval decided on (the guardian's target,
 * which is not itself a thread item — so it stays a summary string, not a field set). */
function actionSummary(action: GuardianApprovalReviewAction): string {
  switch (action.type) {
    case "command":
      return action.command;
    case "execve":
      return [action.program, ...action.argv].join(" ");
    case "writeStdin":
      return "write stdin";
    case "applyPatch":
      return `patch ${action.files.length} file(s)`;
    case "networkAccess":
      return `network ${action.host}:${action.port}`;
    case "mcpToolCall":
      return `${action.server}.${action.toolName}`;
    case "requestPermissions":
      return "request permissions";
  }
}

/** The `type` of a web search's action, when present. */
function webSearchActionType(action: WebSearchAction | null): "search" | "openPage" | "findInPage" | "other" | undefined {
  return action?.type;
}

/**
 * A structured event for a thread item, keyed on its `type` and lifecycle phase.
 *
 * Only the item kinds that read as user-visible work become events; the rest
 * (reasoning, raw messages, housekeeping) are not milestones and drop to
 * undefined. Each keeps the source's own fields (command, files, server/tool,
 * query) rather than flattening them into a sentence.
 */
function itemEvent(item: ThreadItem, phase: "start" | "done", at: number): RunEvent | undefined {
  switch (item.type) {
    case "commandExecution":
      return {
        kind: "command",
        at,
        phase: phase === "start" ? "running" : "ran",
        command: item.command,
        status: item.status,
        ...(item.exitCode != null ? { exitCode: item.exitCode } : {}),
        ...(item.durationMs != null ? { durationMs: item.durationMs } : {}),
      };
    case "fileChange":
      // One event per edit, on completion — a start+done pair for the same edit is
      // noise. Each file keeps its own path + change kind.
      return phase === "done" ? { kind: "edit", at, files: editFiles(item.changes), status: item.status } : undefined;
    case "plan":
      // Emit once, on completion — the plan text is identical on start and done.
      return phase === "done" ? { kind: "plan", at, text: item.text } : undefined;
    case "mcpToolCall":
      return {
        kind: "mcpTool",
        at,
        server: item.server,
        tool: item.tool,
        status: item.status,
        ...(item.durationMs != null ? { durationMs: item.durationMs } : {}),
        ...(item.error ? { error: item.error.message } : {}),
      };
    case "webSearch":
      // Emit the query once, when the search starts — its own field, no longer
      // flattened to a bare "searching the web".
      return phase === "start"
        ? { kind: "webSearch", at, ...(item.query ? { query: item.query } : {}), ...(webSearchActionType(item.action) ? { action: webSearchActionType(item.action)! } : {}) }
        : undefined;
    default:
      return undefined;
  }
}
