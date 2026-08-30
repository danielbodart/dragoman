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

  test("status is a no-IO snapshot and reflects the latest milestone", async () => {
    const { conn, runs, threadId } = bridge();
    await runs.start("do the thing", "/repo");
    const cmd = { type: "commandExecution", id: "c1", pluginId: null, scriptPath: null, command: "cargo test", cwd: "/repo", processId: null, source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null } as ThreadItem;
    conn.emit({ emittedAtMs: 1500, method: "item/started", params: { item: cmd, threadId, turnId: "turn1", startedAtMs: 1500 } });
    // Give the notification loop a tick to fold the event in.
    await Bun.sleep(1);
    expect(runs.status(threadId)?.events.at(-1)).toEqual({ kind: "command", at: 1500, phase: "running", command: "cargo test", status: "inProgress" });
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

    // The middle event would be lost under a single overwritten slot; the drain
    // hands back all three, oldest first — the auto-approval survives.
    expect(runs.hasPending(threadId)).toBe(true);
    expect(runs.drain(threadId)).toEqual([
      { kind: "command", at: 1600, phase: "running", command: 'echo "hi"', status: "inProgress" },
      { kind: "autoApproval", at: 1601, decision: "approved", risk: "low", action: 'echo "hi"' },
      { kind: "command", at: 1602, phase: "ran", command: 'echo "hi"', status: "inProgress" },
    ]);
    // Drained exactly once: a second poll has nothing left to deliver.
    expect(runs.hasPending(threadId)).toBe(false);
    expect(runs.drain(threadId)).toEqual([]);
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
    expect(runs.status(threadId)?.events.at(-1)).toMatchObject({ kind: "command", phase: "running", command: "ls" });

    // The user answers; the decision flows back to Codex as the reply.
    elicitation.answer("acceptForSession");
    expect(await replyPromise).toEqual({ decision: "acceptForSession" });
    expect(runs.status(threadId)?.status).toBe("running");
  });

  test("a human approval rides the LOSSLESS beat sequence (waiting + outcome), never missed at a poll boundary", async () => {
    const { conn, elicitation, runs, threadId } = bridge();
    await runs.start("go", "/repo");
    // Fire an approval and answer it — a fast answer flips the status back to running.
    const reply = conn.emitServerRequest(requestApproval(threadId, "bash -lc 'python3 -c pass'"));
    await Bun.sleep(1);
    elicitation.answer("accept");
    await reply;
    expect(runs.status(threadId)?.status).toBe("running"); // the waiting STATUS has already lifted

    // A poll that only fires now — after the answer — still drains BOTH the waiting and
    // the resolved approval events. The status snapshot alone would have lost the whole approval.
    const approvals = runs.drain(threadId).filter((e) => e.kind === "approval");
    const what = "run `bash -lc 'python3 -c pass'`";
    expect(approvals).toContainEqual({ kind: "approval", at: expect.any(Number), phase: "waiting", what });
    expect(approvals).toContainEqual({ kind: "approval", at: expect.any(Number), phase: "resolved", what, decision: "accept" });
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

  const permissionsReq = (threadId: string, permissions: unknown): ServerRequest => ({
    method: "item/permissions/requestApproval",
    id: 7,
    params: { threadId, turnId: "turn1", itemId: "p1", environmentId: null, startedAtMs: 1000, cwd: "/repo", reason: "needs more room", permissions } as never,
  });

  test("a permissions request (widen the sandbox) is elicited; accept grants what was asked", async () => {
    const { conn, elicitation, runs, threadId } = bridge();
    await runs.start("go", "/repo");
    const requested = { network: { enabled: true }, fileSystem: { read: null, write: ["/build"] } };
    const reply = conn.emitServerRequest(permissionsReq(threadId, requested));
    await Bun.sleep(1);
    expect(elicitation.waiting).toBe(true);
    expect(elicitation.asks[0]?.prompt).toContain("expand its permissions");
    expect(elicitation.asks[0]?.prompt).toContain("network access");
    expect(elicitation.asks[0]?.prompt).toContain("write: /build");
    expect(runs.status(threadId)?.status).toBe("waiting-approval");

    elicitation.answer("accept");
    expect(await reply).toEqual({ permissions: { network: { enabled: true }, fileSystem: { read: null, write: ["/build"] } }, scope: "turn" });
    expect(runs.status(threadId)?.status).toBe("running");
  });

  test("a permissions request: decline grants nothing (an empty profile widens nothing)", async () => {
    const { conn, elicitation, runs, threadId } = bridge();
    await runs.start("go", "/repo");
    const reply = conn.emitServerRequest(permissionsReq(threadId, { network: { enabled: true }, fileSystem: null }));
    await Bun.sleep(1);
    elicitation.answer("decline");
    expect(await reply).toEqual({ permissions: {}, scope: "turn" });
  });

  test("dontAsk: a permissions request is refused without asking the human", async () => {
    const s = (): EffectiveSettings => ({ ...emptySettings(), defaultMode: "dontAsk" });
    const { conn, elicitation, runs, threadId } = bridge("t1", s);
    await runs.start("go", "/repo");
    expect(await conn.emitServerRequest(permissionsReq(threadId, { network: { enabled: true }, fileSystem: null }))).toEqual({ permissions: {}, scope: "turn" });
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
    expect(runs.drain(threadId).find((e) => e.kind === "result")?.text).toBe("all done");
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
    expect(snapshot?.events.at(-1)).toMatchObject({ kind: "command", phase: "running", command: "ls" });
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

describe("usage — context window + rate-limit windows", () => {
  const tokenUsage = (threadId: string, totalTokens: number, modelContextWindow: number | null): Notification => ({
    emittedAtMs: 1800,
    method: "thread/tokenUsage/updated",
    params: {
      threadId,
      turnId: "turn1",
      tokenUsage: {
        total: { totalTokens, inputTokens: totalTokens, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
        last: { totalTokens, inputTokens: totalTokens, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
        modelContextWindow,
      },
    } as never,
  });

  const rateLimits = (primaryMins: number, primaryPct: number, secondaryMins: number, secondaryPct: number): Notification => ({
    emittedAtMs: 1801,
    method: "account/rateLimits/updated",
    params: {
      rateLimits: {
        limitId: null, limitName: null,
        primary: { usedPercent: primaryPct, windowDurationMins: primaryMins, resetsAt: null },
        secondary: { usedPercent: secondaryPct, windowDurationMins: secondaryMins, resetsAt: null },
        credits: null, individualLimit: null, spendControlReached: null, planType: null, rateLimitReachedType: null,
      },
    } as never,
  });

  test("thread/tokenUsage/updated sets ctx as a percentage of the model window", async () => {
    const { conn, runs, threadId } = bridge();
    await runs.start("go", "/repo");
    conn.emit(tokenUsage(threadId, 50_000, 200_000));
    await Bun.sleep(1);
    expect(runs.usage(threadId).ctx).toBe(25);
  });

  test("an unknown context window leaves ctx unset (can't compute a percentage)", async () => {
    const { conn, runs, threadId } = bridge();
    await runs.start("go", "/repo");
    conn.emit(tokenUsage(threadId, 50_000, null));
    await Bun.sleep(1);
    expect(runs.usage(threadId).ctx).toBeUndefined();
  });

  test("rate-limit windows are labelled 5h/7d by duration, not by primary/secondary position", async () => {
    const { conn, runs, threadId } = bridge();
    await runs.start("go", "/repo");
    // Put the WEEKLY window first (primary) and the 5-hour second — classification
    // must still key on windowDurationMins, not position.
    conn.emit(rateLimits(10_080, 18, 300, 42));
    await Bun.sleep(1);
    expect(runs.usage(threadId)).toMatchObject({ "5h": 42, "7d": 18 });
  });

  test("status composes account windows with the run's own context percentage", async () => {
    const { conn, runs, threadId } = bridge();
    await runs.start("go", "/repo");
    conn.emit(rateLimits(300, 42, 10_080, 18));
    conn.emit(tokenUsage(threadId, 120_000, 200_000));
    await Bun.sleep(1);
    expect(runs.usage(threadId)).toEqual({ "5h": 42, "7d": 18, ctx: 60 });
  });

  test("a sparse rate-limit update merges without clearing the other window", async () => {
    const { conn, runs, threadId } = bridge();
    await runs.start("go", "/repo");
    conn.emit(rateLimits(300, 42, 10_080, 18));
    await Bun.sleep(1);
    // A later update carrying ONLY the 5-hour window must leave the weekly standing.
    conn.emit({
      emittedAtMs: 1802,
      method: "account/rateLimits/updated",
      params: { rateLimits: { limitId: null, limitName: null, primary: { usedPercent: 55, windowDurationMins: 300, resetsAt: null }, secondary: null, credits: null, individualLimit: null, spendControlReached: null, planType: null, rateLimitReachedType: null } } as never,
    });
    await Bun.sleep(1);
    expect(runs.usage(threadId)).toMatchObject({ "5h": 55, "7d": 18 });
  });
});

describe("Codex back-channel — mid-run agent messages", () => {
  const agentMessageItem = (text: string): ThreadItem =>
    ({ type: "agentMessage", id: "am1", text, phase: null, memoryCitation: null, delivery: null } as ThreadItem);

  const agentMessageCompleted = (threadId: string, text: string): Notification => ({
    emittedAtMs: 1700,
    method: "item/completed",
    params: { item: agentMessageItem(text), threadId, turnId: "turn1", completedAtMs: 1700 },
  });

  test("a mid-run agentMessage surfaces as a `message` event on the timeline", async () => {
    const { conn, runs, threadId } = bridge();
    await runs.start("go", "/repo");
    conn.emit(agentMessageCompleted(threadId, "I'll start with the parser."));
    await Bun.sleep(1);

    const events = runs.drain(threadId);
    expect(events).toEqual([{ at: 1700, kind: "message", text: "I'll start with the parser." }]);
    // Still running — a message is not terminal.
    expect(runs.status(threadId)?.status).not.toBe("done");
  });

  test("the final message is not delivered twice: a just-streamed message is upgraded to the result", async () => {
    const { conn, runs, threadId } = bridge();
    await runs.start("go", "/repo");
    // The final message streams as its own item/completed, then turn/completed carries
    // the same text as the turn's result — in the SAME poll window (no drain between).
    conn.emit(agentMessageCompleted(threadId, "all done"));
    conn.emit(turnCompleted(threadId, "all done"));
    await Bun.sleep(1);

    const events = runs.drain(threadId);
    // One event, upgraded in place — it keeps the message's own timestamp (1700).
    expect(events).toEqual([{ kind: "result", at: 1700, status: "completed", text: "all done" }]);
    expect(runs.status(threadId)?.status).toBe("done");
  });

  test("a message already drained before completion still yields the result on the done poll", async () => {
    const { conn, runs, threadId } = bridge();
    await runs.start("go", "/repo");
    conn.emit(agentMessageCompleted(threadId, "all done"));
    await Bun.sleep(1);
    // The caller polled and drained the message mid-run.
    expect(runs.drain(threadId).map((e) => e.kind)).toEqual(["message"]);

    // Completion still delivers the result, since the buffer tail no longer holds it.
    conn.emit(turnCompleted(threadId, "all done"));
    await Bun.sleep(1);
    expect(runs.drain(threadId)).toEqual([{ kind: "result", at: 2000, status: "completed", text: "all done" }]);
  });
});
