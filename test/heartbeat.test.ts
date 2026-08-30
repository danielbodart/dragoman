import { describe, expect, test } from "bun:test";
import { eventOf, threadIdOf } from "../src/heartbeat.ts";
import type { Notification } from "../src/codex.ts";
import type { ThreadItem } from "../generated/codex-protocol/ts/v2/ThreadItem.ts";

/**
 * Minimal ThreadItem builders. The generated variants carry many required fields
 * the heartbeat filter never reads; these fill them with harmless defaults so a
 * test can state just the field under test (`command`, `changes`, ...).
 */
function commandItem(command: string, extra: Partial<Record<string, unknown>> = {}): ThreadItem {
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
    ...extra,
  } as ThreadItem;
}

function fileChangeItem(paths: string[]): ThreadItem {
  return {
    type: "fileChange",
    id: "i2",
    changes: paths.map((path) => ({ path, kind: { type: "update", move_path: null }, diff: "" })) as never,
    status: "completed",
  } as ThreadItem;
}

function itemStarted(item: ThreadItem, threadId = "t1", at = 1000): Notification {
  return { emittedAtMs: at, method: "item/started", params: { item, threadId, turnId: "turn1", startedAtMs: at } };
}

function itemCompleted(item: ThreadItem, threadId = "t1", at = 1000): Notification {
  return { emittedAtMs: at, method: "item/completed", params: { item, threadId, turnId: "turn1", completedAtMs: at } };
}

describe("eventOf", () => {
  test("turn/started is not a timeline event (status covers it)", () => {
    expect(eventOf({ emittedAtMs: 5, method: "turn/started", params: { threadId: "t1", turn: turn("inProgress") } }))
      .toBeUndefined();
  });

  test("a started command carries the command as its own field, phase 'running'", () => {
    expect(eventOf(itemStarted(commandItem("cargo test"))))
      .toEqual({ kind: "command", at: 1000, phase: "running", command: "cargo test", status: "inProgress" });
  });

  test("a completed command reads phase 'ran' and surfaces exit code + duration", () => {
    const item = commandItem("ls", { status: "completed", exitCode: 0, durationMs: 42 });
    expect(eventOf(itemCompleted(item, "t1", 2000)))
      .toEqual({ kind: "command", at: 2000, phase: "ran", command: "ls", status: "completed", exitCode: 0, durationMs: 42 });
  });

  test("a file change lists each file by path + change kind, on completion only", () => {
    // The start of an edit is not an event — only its completion, to avoid a start+done pair.
    expect(eventOf(itemStarted(fileChangeItem(["src/a.ts"])))).toBeUndefined();
    expect(eventOf(itemCompleted(fileChangeItem(["src/a.ts", "b.ts"]))))
      .toEqual({ kind: "edit", at: 1000, status: "completed", files: [{ path: "src/a.ts", change: "update" }, { path: "b.ts", change: "update" }] });
  });

  test("a web search surfaces the query (no longer flattened to 'searching the web')", () => {
    const search = { type: "webSearch", id: "w1", query: "rust async traits", action: { type: "search", query: "rust async traits", queries: null }, results: null } as ThreadItem;
    expect(eventOf(itemStarted(search))).toEqual({ kind: "webSearch", at: 1000, query: "rust async traits", action: "search" });
    // Only on start — the completion of the same search adds nothing new.
    expect(eventOf(itemCompleted(search))).toBeUndefined();
  });

  test("an mcp tool call carries server, tool, status and any error", () => {
    const ok = { type: "mcpToolCall", id: "m1", server: "linear", tool: "list_issues", status: "completed", arguments: {}, appContext: null, pluginId: null, readOnlyHint: null, result: null, error: null, durationMs: 88 } as ThreadItem;
    expect(eventOf(itemCompleted(ok))).toEqual({ kind: "mcpTool", at: 1000, server: "linear", tool: "list_issues", status: "completed", durationMs: 88 });
    const failed = { ...ok, status: "failed", error: { message: "boom" }, durationMs: null } as ThreadItem;
    expect(eventOf(itemCompleted(failed))).toEqual({ kind: "mcpTool", at: 1000, server: "linear", tool: "list_issues", status: "failed", error: "boom" });
  });

  test("a completed auto-approval surfaces the decision, risk and action", () => {
    const n: Notification = {
      emittedAtMs: 3000,
      method: "item/autoApprovalReview/completed",
      params: {
        threadId: "t1", turnId: "turn1", startedAtMs: 2999, completedAtMs: 3000,
        reviewId: "rev1", targetItemId: "exec-1", decisionSource: "agent",
        review: { status: "approved", riskLevel: "low", userAuthorization: "high", rationale: "ok" },
        action: { type: "command", source: "agent", command: 'echo "hi"', cwd: "/repo" },
      } as never,
    };
    expect(eventOf(n)).toEqual({ kind: "autoApproval", at: 3000, decision: "approved", risk: "low", action: 'echo "hi"' });
  });

  test("a denied auto-approval drops absent risk and summarises the action", () => {
    const n: Notification = {
      emittedAtMs: 3000,
      method: "item/autoApprovalReview/completed",
      params: {
        threadId: "t1", turnId: "turn1", startedAtMs: 2999, completedAtMs: 3000,
        reviewId: "rev1", targetItemId: null, decisionSource: "agent",
        review: { status: "denied", riskLevel: null, userAuthorization: null, rationale: null },
        action: { type: "networkAccess", target: "https://x.com", host: "x.com", protocol: "https", port: 443 },
      } as never,
    };
    expect(eventOf(n)).toEqual({ kind: "autoApproval", at: 3000, decision: "denied", action: "network x.com:443" });
  });

  test("the firehose (token deltas etc.) produces no event", () => {
    const delta: Notification = { emittedAtMs: 1, method: "item/agentMessage/delta", params: { delta: "hel" } as never };
    expect(eventOf(delta)).toBeUndefined();
  });

  test("a reasoning item is not a milestone", () => {
    const reasoning = { type: "reasoning", id: "r1", summary: [], content: [] } as ThreadItem;
    expect(eventOf(itemStarted(reasoning))).toBeUndefined();
  });

  test("falls back to now when emittedAtMs is absent", () => {
    const before = Date.now();
    const event = eventOf({ method: "item/started", params: { item: commandItem("ls"), threadId: "t1", turnId: "turn1", startedAtMs: 0 } });
    expect(event!.at).toBeGreaterThanOrEqual(before);
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
