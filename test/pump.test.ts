import { describe, expect, test } from "bun:test";
import { startPump } from "../src/pump.ts";
import { ThreadRuns } from "../src/thread-run.ts";
import { FakeAppServer } from "./fakes/app-server.ts";
import { FakeElicitationChannel } from "./fakes/elicitation.ts";
import type { Notification, ServerRequest } from "../src/codex.ts";
import type { EffectiveSettings } from "../src/settings.ts";
import type { ThreadItem } from "../generated/codex-protocol/ts/v2/ThreadItem.ts";

/** Empty effective settings, so the mirror falls to a deterministic safe default in tests. */
const emptySettings = (): EffectiveSettings => ({
  allow: [], deny: [], ask: [], additionalDirectories: [],
  denyRead: [], denyWrite: [], allowRead: [], allowWrite: [],
  allowedDomains: [], deniedDomains: [],
});

/** Wire a bridge over fakes with a canned thread/start + turn/start, ready to drive. */
function bridge(threadId = "t1", settings: () => EffectiveSettings = emptySettings) {
  const conn = new FakeAppServer();
  const elicitation = new FakeElicitationChannel();
  conn.results["thread/start"] = [{ thread: { id: threadId } }];
  conn.results["turn/start"] = [{ turn: { id: "turn1" } }];
  // Match production wiring: ThreadRuns connects lazily via the thunk and the
  // pump is attached on connect. The fake is returned immediately.
  const runs = new ThreadRuns(async () => conn, (c) => startPump(c, runs, elicitation), () => 1000, settings);
  return { conn, elicitation, runs, threadId };
}

function requestApproval(
  threadId: string,
  command: string,
  proposedExecpolicyAmendment?: string[],
): ServerRequest {
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
      proposedExecpolicyAmendment,
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

  test("the DEFAULT settings reader is the disk one, not a self-reference", async () => {
    // Regression: the constructor's default readSettings once referred to the
    // parameter itself (`() => readSettings()`), shadowing the import and
    // recursing forever — start() hung the moment real settings were read.
    // Construct with the real default reader (only connect + onConnect given),
    // point it at an empty config dir so it reads nothing, and assert start()
    // returns rather than hangs. bun:test's per-test timeout fails a hang.
    const conn = new FakeAppServer();
    conn.results["thread/start"] = [{ thread: { id: "t9" } }];
    conn.results["turn/start"] = [{ turn: { id: "turn9" } }];
    const previous = { dir: process.env.CLAUDE_CONFIG_DIR, proj: process.env.CLAUDE_PROJECT_DIR };
    process.env.CLAUDE_CONFIG_DIR = "/nonexistent-dragoman-test-config";
    process.env.CLAUDE_PROJECT_DIR = "/nonexistent-dragoman-test-project";
    try {
      const runs = new ThreadRuns(async () => conn, (c) => startPump(c, runs, new FakeElicitationChannel()));
      expect(await runs.start("do the thing", "/repo")).toBe("t9");
    } finally {
      process.env.CLAUDE_CONFIG_DIR = previous.dir;
      process.env.CLAUDE_PROJECT_DIR = previous.proj;
    }
  });

  test("thread/start mirrors the resolved posture (empty settings → safe default)", async () => {
    const { conn, runs } = bridge();
    await runs.start("do the thing", "/repo");
    const start = conn.requests.find((r) => r.method === "thread/start");
    // Empty settings + no posture → mode "default" → on-request under workspace-write.
    expect(start?.params).toMatchObject({ cwd: "/repo", approvalPolicy: "on-request", sandbox: "workspace-write" });
  });

  test("an explicit posture overrides the static default", async () => {
    const { conn, runs } = bridge();
    await runs.start("plan it", "/repo", "plan");
    const start = conn.requests.find((r) => r.method === "thread/start");
    // plan → untrusted (ask before acting) + read-only.
    expect(start?.params).toMatchObject({ cwd: "/repo", approvalPolicy: "untrusted", sandbox: "read-only" });
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
  test("a mirrored allow-prefix auto-accepts wrapped matching commands without asking the human", async () => {
    const settings = (): EffectiveSettings => ({ ...emptySettings(), allow: ["Bash(npm run test:*)"] });
    const { conn, elicitation, runs, threadId } = bridge("t1", settings);
    await runs.start("run the tests", "/repo");

    expect(await conn.emitServerRequest(requestApproval(threadId, "bash -lc 'npm run test unit'"))).toEqual({
      decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "run", "test"] } },
    });
    expect(elicitation.asks).toEqual([]);

    const replyPromise = conn.emitServerRequest(requestApproval(threadId, "bash -lc 'npm run lint'"));
    await Bun.sleep(1);
    expect(elicitation.waiting).toBe(true);
    elicitation.answer("decline");
    expect(await replyPromise).toEqual({ decision: "decline" });
  });

  test("auto-accept unwraps supported shell forms and preserves bare commands", async () => {
    const settings = (): EffectiveSettings => ({ ...emptySettings(), allow: ["Bash(npm run test:*)"] });
    const { conn, elicitation, runs, threadId } = bridge("t1", settings);
    await runs.start("run the tests", "/repo");

    for (const command of ["/bin/bash -lc 'npm run test unit'", "sh -c 'npm run test unit'", "npm run test unit"]) {
      expect(await conn.emitServerRequest(requestApproval(threadId, command))).toEqual({
        decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "run", "test"] } },
      });
    }
    expect(elicitation.asks).toEqual([]);
  });

  test("auto-accept prefers Codex's proposed execpolicy amendment", async () => {
    const settings = (): EffectiveSettings => ({ ...emptySettings(), allow: ["Bash(npm run test:*)"] });
    const { conn, elicitation, runs, threadId } = bridge("t1", settings);
    await runs.start("run the tests", "/repo");

    expect(await conn.emitServerRequest(requestApproval(threadId, "unparseable wrapper", ["npm", "run", "test", "unit"]))).toEqual({
      decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "run", "test"] } },
    });
    expect(elicitation.asks).toEqual([]);
  });

  test("shell operators limit matching to the first wrapped script segment", async () => {
    const settings = (): EffectiveSettings => ({ ...emptySettings(), allow: ["Bash(rm:*)"] });
    const { conn, elicitation, runs, threadId } = bridge("t1", settings);
    await runs.start("clean up", "/repo");

    const replyPromise = conn.emitServerRequest(requestApproval(threadId, "bash -lc 'echo hi && rm -rf x'"));
    await Bun.sleep(1);
    expect(elicitation.waiting).toBe(true);
    elicitation.answer("decline");
    expect(await replyPromise).toEqual({ decision: "decline" });
  });

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

  test("a file-change approval replies with a valid FileChangeApprovalDecision decline", async () => {
    const { conn, runs } = bridge();
    await runs.start("do the thing", "/repo"); // wires the pump (connects lazily)
    const fileChange: ServerRequest = {
      method: "item/fileChange/requestApproval",
      id: 2,
      params: { threadId: "t1", turnId: "turn1", itemId: "f1" } as never,
    };
    // "decline" IS a valid FileChangeApprovalDecision, so a plain decision reply is correct here.
    expect(await conn.emitServerRequest(fileChange)).toEqual({ decision: "decline" });
  });

  test("currentTime/read is answered with the real time, not an approval decision", async () => {
    const { conn, runs } = bridge();
    await runs.start("do the thing", "/repo");
    const before = Math.floor(Date.now() / 1000);
    const reply = (await conn.emitServerRequest({ method: "currentTime/read", id: 3, params: {} as never })) as { currentTimeAt: number };
    // It is a host service, not an approval — a {decision} reply would be a malformed result.
    expect(reply.currentTimeAt).toBeGreaterThanOrEqual(before);
  });

  test("an unsupported server request throws (→ a JSON-RPC error frame), never a wrong-shaped result", async () => {
    const { conn, runs } = bridge();
    await runs.start("do the thing", "/repo");
    // Host-service and other-shape requests must NOT get {decision:"decline"} —
    // that's a malformed result. Throwing makes the transport send a well-formed
    // error frame instead, which the server can act on.
    for (const method of ["account/chatgptAuthTokens/refresh", "item/tool/call", "execCommandApproval"] as const) {
      const request = { method, id: 9, params: {} as never } as unknown as ServerRequest;
      await expect(conn.emitServerRequest(request)).rejects.toThrow(/unsupported server request/);
    }
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
