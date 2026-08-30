/**
 * The peer-agent lifecycle tools — cancel, steer, continue — over the fake
 * app-server. Each provisions a FRESH conn per run (as production does), so a
 * continuation resumes on its own connection, not the one the finished run used.
 */
import { describe, expect, test } from "bun:test";
import { startPump } from "../src/pump.ts";
import { ThreadRuns } from "../src/thread-run.ts";
import { FakeAppServer } from "./fakes/app-server.ts";
import { FakeElicitationChannel } from "./fakes/elicitation.ts";
import type { Notification } from "../src/codex.ts";
import type { EffectiveSettings } from "../src/settings.ts";

const emptySettings = (): EffectiveSettings => ({
  allow: [], deny: [], ask: [], additionalDirectories: [],
  denyRead: [], denyWrite: [], allowRead: [], allowWrite: [],
  allowedDomains: [], deniedDomains: [],
});

/** A fake conn pre-canned to answer thread/start, thread/resume and turn/start. */
function makeConn(threadId = "t1", turnId = "turn1"): FakeAppServer {
  const conn = new FakeAppServer();
  conn.results["thread/start"] = [{ thread: { id: threadId }, model: "test-model", reasoningEffort: null }];
  conn.results["thread/resume"] = [{ thread: { id: threadId }, model: "test-model", reasoningEffort: null, cwd: "/repo", runtimeWorkspaceRoots: [] }];
  conn.results["turn/start"] = [{ turn: { id: turnId } }];
  return conn;
}

/** A registry that hands out the queued conns in order — one per provision, as in prod. */
function lab(settings: () => EffectiveSettings = emptySettings) {
  const elicitation = new FakeElicitationChannel();
  const conns: FakeAppServer[] = [];
  const provision = async () => {
    const conn = conns.shift();
    if (!conn) throw new Error("test provisioned no conn");
    return { conn };
  };
  const runs = new ThreadRuns(provision, (c) => startPump(c, runs, elicitation), () => 1000, settings);
  return { runs, conns };
}

function turnCompleted(threadId: string, status = "completed"): Notification {
  const message = { type: "agentMessage", id: "m1", text: "all done", phase: null, memoryCitation: null, delivery: null };
  return {
    emittedAtMs: 2000,
    method: "turn/completed",
    params: { threadId, turn: { id: "turn1", items: [message], itemsView: "complete", status, error: null, startedAt: null, completedAt: null, durationMs: null } as never },
  };
}

describe("codex_cancel", () => {
  test("interrupts the active turn by (threadId, turnId)", async () => {
    const { runs, conns } = lab();
    const conn = makeConn("t1");
    conns.push(conn);
    const handle = await runs.start("go", "/repo");
    await Bun.sleep(1); // let the turn/start reply record the active turn id

    const message = await runs.cancel(handle);
    expect(message).toContain("Requested cancel");
    expect(conn.requests.find((r) => r.method === "turn/interrupt")?.params).toEqual({ threadId: "t1", turnId: "turn1" });
  });

  test("unknown handle is a clean message, not an error", async () => {
    const { runs } = lab();
    expect(await runs.cancel("nope")).toContain('No Codex task with handle "nope"');
  });

  test("a finished task has nothing to cancel", async () => {
    const { runs, conns } = lab();
    const conn = makeConn("t1");
    conns.push(conn);
    const handle = await runs.start("go", "/repo");
    conn.emit(turnCompleted("t1"));
    await Bun.sleep(1);
    expect(runs.status(handle)?.status).toBe("done");
    expect(await runs.cancel(handle)).toContain("already finished");
  });
});

describe("codex_steer", () => {
  test("injects text into the running turn and adopts the reply's turn id", async () => {
    const { runs, conns } = lab();
    const conn = makeConn("t1");
    conn.results["turn/steer"] = [{ turnId: "turn2" }];
    conns.push(conn);
    const handle = await runs.start("go", "/repo");
    await Bun.sleep(1);

    const message = await runs.steer(handle, "also check the Windows path");
    expect(message).toContain("Steered");
    expect(conn.requests.find((r) => r.method === "turn/steer")?.params).toEqual({
      threadId: "t1",
      input: [{ type: "text", text: "also check the Windows path", text_elements: [] }],
      expectedTurnId: "turn1",
    });
    expect(runs.status(handle)?.turnId).toBe("turn2");
  });

  test("a stale-turn rejection is reported as a status line, never thrown", async () => {
    const { runs, conns } = lab();
    const conn = makeConn("t1");
    conn.failWith["turn/steer"] = new Error("expected turn id mismatch");
    conns.push(conn);
    const handle = await runs.start("go", "/repo");
    await Bun.sleep(1);

    const message = await runs.steer(handle, "nudge");
    expect(message).toContain("Could not steer");
    expect(message).toContain("expected turn id mismatch");
  });
});

describe("codex_continue", () => {
  test("resumes the finished thread on a fresh conn and re-mirrors the current settings", async () => {
    const { runs, conns } = lab();
    const conn1 = makeConn("t1", "turn1");
    conns.push(conn1);
    const handle = await runs.start("go", "/repo");
    conn1.emit(turnCompleted("t1"));
    await Bun.sleep(1);
    expect(runs.status(handle)?.status).toBe("done");

    const conn2 = makeConn("t1", "turn2");
    conns.push(conn2);
    const message = await runs.continueRun(handle, "now update the tests");
    expect(message).toContain("Continuing");

    // Resumed by thread id, under a freshly-mirrored policy (cwd carried over).
    const resume = conn2.requests.find((r) => r.method === "thread/resume")?.params as { threadId: string; cwd: string };
    expect(resume.threadId).toBe("t1");
    expect(resume.cwd).toBe("/repo");
    // A new turn was kicked off on the resumed thread, and its id is now tracked.
    expect(conn2.requests.some((r) => r.method === "turn/start")).toBe(true);
    await Bun.sleep(1);
    expect(runs.status(handle)?.turnId).toBe("turn2");
    expect(runs.status(handle)?.status).toBe("running");
  });

  test("a still-running task is steered, not continued", async () => {
    const { runs, conns } = lab();
    conns.push(makeConn("t1"));
    const handle = await runs.start("go", "/repo");
    await Bun.sleep(1);
    expect(await runs.continueRun(handle, "next")).toContain("still running");
  });

  test("unknown handle is a clean message", async () => {
    const { runs } = lab();
    expect(await runs.continueRun("nope", "next")).toContain('No Codex task with handle "nope"');
  });
});
