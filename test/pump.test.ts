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
  conn.results["thread/start"] = [{ thread: { id: threadId }, model: "test-model", reasoningEffort: null }];
  conn.results["turn/start"] = [{ turn: { id: "turn1" } }];
  // Match production wiring: ThreadRuns provisions per run via the thunk and the
  // pump is attached on connect. The same fake is returned for the run.
  const runs = new ThreadRuns(async () => ({ conn }), (c) => startPump(c, runs, elicitation), () => 1000, settings);
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
      const runs = new ThreadRuns(async () => ({ conn }), (c) => startPump(c, runs, new FakeElicitationChannel()));
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
    // Empty settings + no posture → mode "default" (Manual): reads-only, ask for
    // writes → :read-only profile + untrusted (escapes raised) + reviewer "user"
    // (writes/edits escalate → the human). Sandbox enum is NOT sent.
    const params = start?.params as { cwd?: string; approvalPolicy?: unknown; approvalsReviewer?: unknown; permissions?: string; sandbox?: unknown };
    expect(params.cwd).toBe("/repo");
    expect(params.approvalPolicy).toBe("untrusted");
    expect(params.approvalsReviewer).toBe("user");
    expect(params.permissions).toBe("dragoman-read-only");
    expect(params.sandbox).toBeUndefined();
  });

  test("an explicit posture overrides the static default", async () => {
    const { conn, runs } = bridge();
    await runs.start("plan it", "/repo", "plan");
    const start = conn.requests.find((r) => r.method === "thread/start");
    // plan → on-request (reads run freely; writes hard-fail) + read-only profile. The
    // native plan mode (collaborationMode) rides turn/start, not thread/start.
    expect(start?.params).toMatchObject({ cwd: "/repo", approvalPolicy: "on-request", permissions: "dragoman-read-only" });
    // The native plan posture rides the turn, with settings.model filled from the
    // resolved thread/start response ("test-model").
    const turn = conn.requests.find((r) => r.method === "turn/start");
    expect(turn?.params).toMatchObject({
      collaborationMode: { mode: "plan", settings: { model: "test-model", reasoning_effort: null, developer_instructions: null } },
    });
  });

  test("non-plan postures send no collaborationMode", async () => {
    const { conn, runs } = bridge();
    await runs.start("go", "/repo", "acceptEdits");
    const turn = conn.requests.find((r) => r.method === "turn/start");
    expect((turn?.params as { collaborationMode?: unknown }).collaborationMode).toBeUndefined();
  });

  test("runtimeWorkspaceRoots carries cwd + additionalDirectories", async () => {
    // Roots ride the profile path, which exists when Claude is sandboxing.
    const settings = (): EffectiveSettings => ({ ...emptySettings(), sandboxEnabled: true, additionalDirectories: ["/data", "/cache"] });
    const { conn, runs } = bridge("t1", settings);
    await runs.start("go", "/repo");
    const start = conn.requests.find((r) => r.method === "thread/start");
    expect((start?.params as { runtimeWorkspaceRoots?: string[] }).runtimeWorkspaceRoots).toEqual(["/repo", "/data", "/cache"]);
  });

  test("status is a no-IO snapshot and reflects the latest heartbeat", async () => {
    const { conn, runs, threadId } = bridge();
    await runs.start("do the thing", "/repo");
    conn.emit({ emittedAtMs: 1500, method: "turn/started", params: { threadId, turn: { id: "turn1", items: [], itemsView: "complete", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null } as never } });
    // Give the notification loop a tick to fold the beat in.
    await Bun.sleep(1);
    expect(runs.status(threadId)?.latestBeat?.text).toBe("starting turn");
  });

  test("beats pile up between polls and drain in order — an auto-approval is not clobbered", async () => {
    const { conn, runs, threadId } = bridge();
    await runs.start("do the thing", "/repo");
    const cmd = { type: "commandExecution", id: "c1", pluginId: null, scriptPath: null, command: 'echo "hi"', cwd: "/repo", processId: null, source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null } as ThreadItem;

    // Three milestones land back-to-back before any status poll: the command
    // starting, the guardian silently auto-approving it, then it completing.
    conn.emit({ emittedAtMs: 1600, method: "item/started", params: { item: cmd, threadId, turnId: "turn1", startedAtMs: 1600 } });
    conn.emit({ emittedAtMs: 1601, method: "item/autoApprovalReview/completed", params: { threadId, turnId: "turn1", startedAtMs: 1600, completedAtMs: 1601, reviewId: "r1", targetItemId: "c1", decisionSource: "agent", review: { status: "approved", riskLevel: "low", userAuthorization: "high", rationale: null }, action: { type: "command", source: "agent", command: 'echo "hi"', cwd: "/repo" } } as never });
    conn.emit({ emittedAtMs: 1602, method: "item/completed", params: { item: cmd, threadId, turnId: "turn1", completedAtMs: 1602 } });
    await Bun.sleep(1);

    // The middle beat would be lost under a single overwritten slot; the drain
    // hands back all three, oldest first — the auto-approval survives.
    expect(runs.hasPendingBeats(threadId)).toBe(true);
    expect(runs.drainBeats(threadId).map((b) => b.text)).toEqual([
      'running: echo "hi"',
      'auto-approved (risk: low): echo "hi"',
      'ran: echo "hi"',
    ]);
    // Drained exactly once: a second poll has nothing left to deliver.
    expect(runs.hasPendingBeats(threadId)).toBe(false);
    expect(runs.drainBeats(threadId)).toEqual([]);
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

  test("Codex's own proposed amendment is NOT trusted to skip the human", async () => {
    // Fail-open guard: proposedExecpolicyAmendment is supplied by Codex, the
    // party this gate mediates. A command the real string can't justify must
    // still reach the human even when Codex proposes a matching prefix.
    const settings = (): EffectiveSettings => ({ ...emptySettings(), allow: ["Bash(npm run test:*)"] });
    const { conn, elicitation, runs, threadId } = bridge("t1", settings);
    await runs.start("run the tests", "/repo");

    const replyPromise = conn.emitServerRequest(requestApproval(threadId, "rm -rf /", ["npm", "run", "test", "unit"]));
    await Bun.sleep(1);
    expect(elicitation.waiting).toBe(true);
    elicitation.answer("decline");
    expect(await replyPromise).toEqual({ decision: "decline" });
  });

  test("a chained command whose first segment matches is NOT auto-accepted", async () => {
    // Shell-chaining bypass: auto-approval covers the WHOLE command, so a benign
    // matching prefix must not carry a chained `&& rm` past the gate. Any command
    // that is more than a lone simple command falls through to the human.
    const settings = (): EffectiveSettings => ({ ...emptySettings(), allow: ["Bash(npm run test:*)"] });
    const { conn, elicitation, runs, threadId } = bridge("t1", settings);
    await runs.start("run the tests", "/repo");

    const replyPromise = conn.emitServerRequest(requestApproval(threadId, "bash -lc 'npm run test && rm -rf /'"));
    await Bun.sleep(1);
    expect(elicitation.waiting).toBe(true);
    elicitation.answer("decline");
    expect(await replyPromise).toEqual({ decision: "decline" });
  });

  test("a denied command is pre-declined without asking the human", async () => {
    const settings = (): EffectiveSettings => ({ ...emptySettings(), deny: ["Bash(curl:*)"] });
    const { conn, elicitation, runs, threadId } = bridge("t1", settings);
    await runs.start("fetch stuff", "/repo");

    expect(await conn.emitServerRequest(requestApproval(threadId, "curl https://evil.example"))).toEqual({ decision: "decline" });
    expect(elicitation.asks).toEqual([]);
  });

  test("deny is fail-closed: it catches a wrapped and chained denied command", async () => {
    const settings = (): EffectiveSettings => ({ ...emptySettings(), deny: ["Bash(curl:*)"] });
    const { conn, elicitation, runs, threadId } = bridge("t1", settings);
    await runs.start("fetch stuff", "/repo");

    for (const command of ["bash -lc 'curl https://evil.example'", "bash -lc 'echo ok && curl https://evil.example'", "FOO=1 curl https://evil.example"]) {
      expect(await conn.emitServerRequest(requestApproval(threadId, command))).toEqual({ decision: "decline" });
    }
    expect(elicitation.asks).toEqual([]);
  });

  test("deny wins over allow when a command matches both", async () => {
    const settings = (): EffectiveSettings => ({ ...emptySettings(), allow: ["Bash(git:*)"], deny: ["Bash(git push:*)"] });
    const { conn, elicitation, runs, threadId } = bridge("t1", settings);
    await runs.start("push", "/repo");

    expect(await conn.emitServerRequest(requestApproval(threadId, "git push origin main"))).toEqual({ decision: "decline" });
    expect(elicitation.asks).toEqual([]);
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

  test("a file-change approval is elicited to the human, then replies with the decision", async () => {
    const { conn, elicitation, runs, threadId } = bridge();
    await runs.start("do the thing", "/repo"); // wires the pump (connects lazily)
    const fileChange: ServerRequest = {
      method: "item/fileChange/requestApproval",
      id: 2,
      params: { threadId, turnId: "turn1", itemId: "f1", reason: "write outside workspace" } as never,
    };
    // Fire but don't await — it settles only once the human answers.
    const replyPromise = conn.emitServerRequest(fileChange);
    await Bun.sleep(1);
    expect(elicitation.waiting).toBe(true);
    expect(elicitation.asks[0]?.prompt).toContain("write files");
    expect(elicitation.asks[0]?.decisions).toEqual(["accept", "acceptForSession", "decline", "cancel"]);
    expect(runs.status(threadId)?.status).toBe("waiting-approval");

    elicitation.answer("decline");
    expect(await replyPromise).toEqual({ decision: "decline" }); // a valid FileChangeApprovalDecision
    expect(runs.status(threadId)?.status).toBe("running");
  });

  const fileChangeReq = (threadId: string): ServerRequest => ({
    method: "item/fileChange/requestApproval",
    id: 5,
    params: { threadId, turnId: "turn1", itemId: "f1" } as never,
  });

  test("dontAsk: an unmatched command is declined without asking the human", async () => {
    const s = (): EffectiveSettings => ({ ...emptySettings(), defaultMode: "dontAsk" });
    const { conn, elicitation, runs, threadId } = bridge("t1", s);
    await runs.start("go", "/repo");
    expect(await conn.emitServerRequest(requestApproval(threadId, "curl evil.example"))).toEqual({ decision: "decline" });
    expect(elicitation.asks).toEqual([]);
  });

  test("dontAsk: a file edit is declined without asking the human", async () => {
    const s = (): EffectiveSettings => ({ ...emptySettings(), defaultMode: "dontAsk" });
    const { conn, elicitation, runs, threadId } = bridge("t1", s);
    await runs.start("go", "/repo");
    expect(await conn.emitServerRequest(fileChangeReq(threadId))).toEqual({ decision: "decline" });
    expect(elicitation.asks).toEqual([]);
  });

  test("acceptEdits: an ESCAPED file edit still asks the human (in-scope edits auto-run via the sandbox)", async () => {
    const s = (): EffectiveSettings => ({ ...emptySettings(), defaultMode: "acceptEdits" });
    const { conn, elicitation, runs, threadId } = bridge("t1", s);
    await runs.start("go", "/repo");
    const reply = conn.emitServerRequest(fileChangeReq(threadId));
    await Bun.sleep(1);
    expect(elicitation.waiting).toBe(true); // routed to the human, not auto-accepted
    elicitation.answer("decline");
    expect(await reply).toEqual({ decision: "decline" });
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

describe("long-poll (waitForUpdate) — event-driven status", () => {
  test("wakes the instant the run changes, not on a timer", async () => {
    const { conn, runs, threadId } = bridge();
    await runs.start("do it", "/repo");
    const since = runs.revision(threadId);

    // Park on a LONG timeout, then complete the turn — the wake must come from
    // the completion, well before the timeout would fire.
    const poll = runs.waitForUpdate(threadId, since, 60_000);
    const started = Date.now();
    conn.emit(turnCompleted(threadId, "all done"));
    const { snapshot, revision } = await poll;

    expect(snapshot?.status).toBe("done");
    expect(revision).toBeGreaterThan(since);
    expect(Date.now() - started).toBeLessThan(1_000); // woke on the event, not the 60s cap
  });

  test("wakes on a heartbeat beat, carrying the latest one", async () => {
    const { conn, runs, threadId } = bridge();
    await runs.start("do it", "/repo");
    const since = runs.revision(threadId);

    const poll = runs.waitForUpdate(threadId, since, 60_000);
    conn.emit({
      emittedAtMs: 1600,
      method: "item/started",
      params: { item: { type: "commandExecution", id: "c1", pluginId: null, scriptPath: null, command: "ls", cwd: "/repo", processId: null, source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null } as ThreadItem, threadId, turnId: "turn1", startedAtMs: 1600 },
    });
    const { snapshot } = await poll;
    expect(snapshot?.latestBeat?.text).toBe("running: ls");
  });

  test("returns immediately when the run is already terminal", async () => {
    const { conn, runs, threadId } = bridge();
    await runs.start("do it", "/repo");
    conn.emit(turnCompleted(threadId, "done"));
    await Bun.sleep(1);

    // Even with a `since` far ahead, a terminal run short-circuits — no waiting.
    const started = Date.now();
    const { snapshot } = await runs.waitForUpdate(threadId, 9_999, 60_000);
    expect(snapshot?.status).toBe("done");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("returns after the timeout when nothing changes", async () => {
    const { runs, threadId } = bridge();
    await runs.start("do it", "/repo");
    const since = runs.revision(threadId);

    const started = Date.now();
    const { revision } = await runs.waitForUpdate(threadId, since, 40);
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
    expect(revision).toBe(since); // nothing advanced it
  });
});
