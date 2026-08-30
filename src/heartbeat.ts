/**
 * The heartbeat filter (PLAN §6): the whole ~80-type notification firehose
 * collapsed to a sparse sequence of coarse one-liners.
 *
 * `beatOf` is pure — `Notification → Beat | undefined` — so it is tested against
 * plain notification literals with no socket in sight, the same way tidewaiter
 * tests `toRunning`/`netBytesOf`. Anything not explicitly recognised returns
 * `undefined` and is dropped by the pump before it ever reaches a run's
 * `latestBeat`: that "match a milestone or drop it" shape is what enforces
 * "coarse and few" by construction, rather than by a filter the pump has to
 * remember to apply.
 */
import type { Notification } from "./codex.ts";
import type { Beat } from "./model.ts";
import type { ThreadItem } from "../generated/codex-protocol/ts/v2/ThreadItem.ts";
import type { ItemGuardianApprovalReviewCompletedNotification } from "../generated/codex-protocol/ts/v2/ItemGuardianApprovalReviewCompletedNotification.ts";
import type { GuardianApprovalReviewAction } from "../generated/codex-protocol/ts/v2/GuardianApprovalReviewAction.ts";

/** The `threadId` a notification concerns, or undefined for feed-wide (account/app/model) events. */
export function threadIdOf(notification: Notification): string | undefined {
  const params = notification.params as { threadId?: unknown };
  return typeof params.threadId === "string" ? params.threadId : undefined;
}

/**
 * A coarse status line for a notification, or undefined if it is not a milestone.
 *
 * Only a handful of the notification types produce a beat; the rest — token and
 * reasoning deltas, raw response items, account/model housekeeping — are the
 * firehose, consumed and dropped.
 */
export function beatOf(notification: Notification): Beat | undefined {
  const at = notification.emittedAtMs ?? Date.now();

  switch (notification.method) {
    case "turn/started":
      return { at, text: "starting turn" };
    case "item/started":
      return itemBeat(notification.params.item, "start", at);
    case "item/completed":
      return itemBeat(notification.params.item, "done", at);
    case "turn/completed":
      return { at, text: turnCompletionText(notification.params.turn.status) };
    case "item/autoApprovalReview/completed":
      return approvalBeat(notification.params, at);
    case "error":
      return { at, text: `error: ${notification.params.error.message}` };
    default:
      return undefined;
  }
}

/** The milestone text for a turn reaching a terminal status: failed, cancelled
 * (an interrupt landed), or a clean completion. */
function turnCompletionText(status: string): string {
  if (status === "failed") return "turn failed";
  if (status === "interrupted") return "turn cancelled";
  return "turn complete";
}

/**
 * A beat for a completed auto-approval review — Codex's internal guardian
 * deciding, without a human prompt, whether an action clears the sandbox wall.
 * Under `approvalPolicy: granular` these fire silently; surfacing the decision
 * (and what it was about) makes the otherwise-invisible auto-approval visible in
 * the heartbeat, so a watcher sees *why* a run sailed past a command that would
 * normally prompt. `started`, `guardianWarning` (a redundant human summary of
 * this same decision) and `strictReviewRequired` are not milestones here.
 */
function approvalBeat(params: ItemGuardianApprovalReviewCompletedNotification, at: number): Beat {
  const { status, riskLevel } = params.review;
  const verb =
    status === "approved" ? "auto-approved"
    : status === "denied" ? "auto-denied"
    : `auto-review ${status === "timedOut" ? "timed out" : status}`;
  const risk = riskLevel ? ` (risk: ${riskLevel})` : "";
  return { at, text: `${verb}${risk}: ${actionSummary(params.action)}` };
}

/** A short, coarse label for the action an approval review decided on. */
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

/**
 * A beat for a thread item, keyed on its `type` and lifecycle phase.
 *
 * Only the item kinds that read as user-visible work become beats; the rest
 * (reasoning, raw messages, housekeeping items) are not milestones and drop to
 * undefined.
 */
function itemBeat(item: ThreadItem, phase: "start" | "done", at: number): Beat | undefined {
  switch (item.type) {
    case "commandExecution":
      return { at, text: `${phase === "start" ? "running" : "ran"}: ${item.command}` };
    case "fileChange":
      return { at, text: `editing ${item.changes.length} file(s)` };
    case "plan":
      return { at, text: `plan: ${item.text}` };
    case "mcpToolCall":
      return { at, text: `${item.server}.${item.tool}` };
    case "webSearch":
      return { at, text: "searching the web" };
    default:
      return undefined;
  }
}
