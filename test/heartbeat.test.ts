import { describe, expect, test } from "bun:test";
import { beatOf, threadIdOf } from "../src/heartbeat.ts";
import type { Notification } from "../src/codex.ts";
import type { ThreadItem } from "../generated/codex-protocol/ts/v2/ThreadItem.ts";

/**
 * Minimal ThreadItem builders. The generated variants carry many required fields
 * that the heartbeat filter never reads; these fill them with harmless defaults
 * so a test can state just the field under test (`command`, `changes`, ...).
 */
function commandItem(command: string): ThreadItem {
  return {
    type: "commandExecution",
    id: "i1",
    pluginId: null,
    scriptPath: null,
    command,
    cwd: "/repo",
    processId: null,
    source: "agent",
    status: "inProgress",
    commandActions: [],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
  } as ThreadItem;
}

function fileChangeItem(count: number): ThreadItem {
  return {
    type: "fileChange",
    id: "i2",
    changes: Array.from({ length: count }, () => ({})) as never,
    status: "completed",
  } as ThreadItem;
}

function itemStarted(item: ThreadItem, threadId = "t1", at = 1000): Notification {
  return { emittedAtMs: at, method: "item/started", params: { item, threadId, turnId: "turn1", startedAtMs: at } };
}

describe("beatOf", () => {
  test("turn/started is a beat", () => {
    expect(beatOf({ emittedAtMs: 5, method: "turn/started", params: { threadId: "t1", turn: turn("inProgress") } }))
      .toEqual({ at: 5, text: "starting turn" });
  });

  test("a started command execution names the command", () => {
    expect(beatOf(itemStarted(commandItem("cargo test")))).toEqual({ at: 1000, text: "running: cargo test" });
  });

  test("a completed command execution reads 'ran'", () => {
    const at = 2000;
    const n: Notification = { emittedAtMs: at, method: "item/completed", params: { item: commandItem("ls"), threadId: "t1", turnId: "turn1", completedAtMs: at } };
    expect(beatOf(n)).toEqual({ at, text: "ran: ls" });
  });

  test("a file change counts the files touched", () => {
    expect(beatOf(itemStarted(fileChangeItem(3)))).toEqual({ at: 1000, text: "editing 3 file(s)" });
  });

  test("turn/completed distinguishes success from failure", () => {
    expect(beatOf({ method: "turn/completed", params: { threadId: "t1", turn: turn("completed") }, emittedAtMs: 9 }))
      .toEqual({ at: 9, text: "turn complete" });
    expect(beatOf({ method: "turn/completed", params: { threadId: "t1", turn: turn("failed") }, emittedAtMs: 9 }))
      .toEqual({ at: 9, text: "turn failed" });
  });

  test("an error notification surfaces the message", () => {
    const n: Notification = {
      emittedAtMs: 7,
      method: "error",
      params: { error: { message: "boom", codexErrorInfo: null, additionalDetails: null }, willRetry: false, threadId: "t1", turnId: "turn1" },
    };
    expect(beatOf(n)).toEqual({ at: 7, text: "error: boom" });
  });

  test("the firehose (token deltas etc.) produces no beat", () => {
    const delta: Notification = { emittedAtMs: 1, method: "item/agentMessage/delta", params: { delta: "hel" } as never };
    expect(beatOf(delta)).toBeUndefined();
  });

  test("a reasoning item is not a milestone", () => {
    const reasoning = { type: "reasoning", id: "r1", summary: [], content: [] } as ThreadItem;
    expect(beatOf(itemStarted(reasoning))).toBeUndefined();
  });

  test("falls back to now when emittedAtMs is absent", () => {
    const before = Date.now();
    const beat = beatOf({ method: "turn/started", params: { threadId: "t1", turn: turn("inProgress") } });
    expect(beat!.at).toBeGreaterThanOrEqual(before);
  });
});

describe("threadIdOf", () => {
  test("reads threadId from a thread-scoped notification", () => {
    expect(threadIdOf(itemStarted(commandItem("ls"), "abc"))).toBe("abc");
  });

  test("returns undefined for a feed-wide notification with no threadId", () => {
    const accountUpdate: Notification = { emittedAtMs: 1, method: "account/updated", params: {} as never };
    expect(threadIdOf(accountUpdate)).toBeUndefined();
  });
});

function turn(status: "inProgress" | "completed" | "failed" | "interrupted") {
  return { id: "turn1", items: [], itemsView: "complete", status, error: null, startedAt: null, completedAt: null, durationMs: null } as never;
}
