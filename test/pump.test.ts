import { describe, expect, test } from "bun:test";
import { startPump } from "../src/pump.ts";
import { ThreadRuns } from "../src/thread-run.ts";
import { FakeAppServer } from "./fakes/app-server.ts";
import { FakeElicitationChannel } from "./fakes/elicitation.ts";
import type { Notification, ServerRequest } from "../src/codex.ts";
import type { ThreadItem } from "../generated/codex-protocol/ts/v2/ThreadItem.ts";

/** Wire a bridge over fakes with a canned thread/start + turn/start, ready to drive. */
function bridge(threadId = "t1") {
  const conn = new FakeAppServer();
  const elicitation = new FakeElicitationChannel();
  conn.results["thread/start"] = [{ thread: { id: threadId } }];
  conn.results["turn/start"] = [{ turn: { id: "turn1" } }];
  const runs = new ThreadRuns(conn, () => 1000);
  const pump = startPump(conn, runs, elicitation);
  return { conn, elicitation, runs, pump, threadId };
}

function requestApproval(threadId: string, command: string): ServerRequest {
  return {
    method: "item/commandExecution/requestApproval",
    id: 1,
    params: {
      kind: "command",
      threadId,
      turnId: "turn1",
      itemId: "item1",
      startedAtMs: 1000,
      environmentId: null,
      command,
      availableDecisions: ["accept", "acceptForSession", "decline"],
    },
  };
}

function turnCompleted(threadId: string, text: string): Notification {
  const message: ThreadItem = { type: "agentMessage", id: "m1", text, phase: null, memoryCitation: null, delivery: null };
  return {
    emittedAtMs: 2000,
    method: "turn/completed",
    params: {
      threadId,
      turn: { id: "turn1", items: [message], itemsView: "complete", status: "completed", error: null, startedAt: null, completedAt: null, durationMs: null } as never,
    },
  };
}

describe("codex_run / codex_status", () => {
  test("start returns a handle immediately, before the turn finishes", async () => {
    const { runs, threadId } = bridge();
    const handle = await runs.start("do the thing", "/repo");
    expect(handle).toBe(threadId);
    // The turn hasn't reported completion, so status is not "done".
    expect(runs.status(handle)?.status).not.toBe("done");
  });

  test("thread/start carries the fixed slice policy that will trigger approvals", async () => {
    const { conn, runs } = bridge();
    await runs.start("do the thing", "/repo");
    const start = conn.requests.find((r) => r.method === "thread/start");
    expect(start?.params).toMatchObject({ cwd: "/repo", approvalPolicy: "on-request", sandbox: "workspace-write" });
  });

  test("status is a no-IO snapshot and reflects the latest heartbeat", async () => {
    const { conn, runs, threadId } = bridge();
    await runs.start("do the thing", "/repo");
    conn.emit({ emittedAtMs: 1500, method: "turn/started", params: { threadId, turn: { id: "turn1", items: [], itemsView: "complete", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null } as never } });
    // Give the notification loop a tick to fold the beat in.
    await Bun.sleep(1);
    expect(runs.status(threadId)?.latestBeat?.text).toBe("starting turn");
  });
});

describe("the approval bridge — the anti-hang property", () => {
  test("an approval fires an elicitation, and status keeps answering while it waits", async () => {
    const { conn, elicitation, runs, threadId } = bridge();
    await runs.start("delete build", "/repo");

    // Codex asks to run a command. Fire the server-request but DO NOT await it
    // yet — it will not settle until the user answers, exactly like real life.
    const replyPromise = conn.emitServerRequest(requestApproval(threadId, "rm -rf build/"));
    await Bun.sleep(1);

    // The elicitation is in front of the user, and the run says so...
    expect(elicitation.waiting).toBe(true);
    expect(elicitation.asks[0]?.prompt).toContain("rm -rf build/");
    expect(elicitation.asks[0]?.decisions).toEqual(["accept", "acceptForSession", "decline"]);

    // ...and — the whole point — codex_status STILL ANSWERS, it is not blocked.
    expect(runs.status(threadId)?.status).toBe("waiting-approval");

    // A notification arriving DURING the pending approval is still processed:
    // the notification loop was never stalled by the unanswered request.
    conn.emit({ emittedAtMs: 1600, method: "item/started", params: { item: { type: "commandExecution", id: "c1", pluginId: null, scriptPath: null, command: "ls", cwd: "/repo", processId: null, source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null } as ThreadItem, threadId, turnId: "turn1", startedAtMs: 1600 } });
    await Bun.sleep(1);
    expect(runs.status(threadId)?.latestBeat?.text).toBe("running: ls");

    // The user answers; the decision flows back to Codex as the reply.
    elicitation.answer("acceptForSession");
    expect(await replyPromise).toEqual({ decision: "acceptForSession" });
    expect(runs.status(threadId)?.status).toBe("running");
  });

  test("a non-command server request is safely declined, never left unanswered", async () => {
    const { conn } = bridge();
    const fileChange: ServerRequest = {
      method: "item/fileChange/requestApproval",
      id: 2,
      params: { threadId: "t1", turnId: "turn1", itemId: "f1" } as never,
    };
    expect(await conn.emitServerRequest(fileChange)).toEqual({ decision: "decline" });
  });

  test("a completed turn carries the final agent message as the result", async () => {
    const { conn, runs, threadId } = bridge();
    await runs.start("do the thing", "/repo");
    conn.emit(turnCompleted(threadId, "all done"));
    await Bun.sleep(1);
    expect(runs.status(threadId)?.status).toBe("done");
    expect(runs.status(threadId)?.result).toBe("all done");
  });
});
