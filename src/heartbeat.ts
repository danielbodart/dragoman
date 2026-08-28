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
      return { at, text: notification.params.turn.status === "failed" ? "turn failed" : "turn complete" };
    case "error":
      return { at, text: `error: ${notification.params.error.message}` };
    default:
      return undefined;
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
