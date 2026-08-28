/**
 * The run registry and the two MCP tools' logic.
 *
 * This is Dragoman's `daemon.ts` analogue: a class holding injected
 * collaborators (the `AppServerConn`, a clock) plus the in-memory map of live
 * runs. It does I/O only through the injected interface, so it is unit-tested
 * against `FakeAppServer` with no socket — the same discipline as tidewaiter's
 * `Tidewaiter`.
 *
 * `start` (the `codex_run` tool) must return a handle IMMEDIATELY: it awaits only
 * `thread/start` + `turn/start`, both fast kick-off RPCs, then lets the turn run
 * in the background. A tool call that blocked on the whole turn would hit Claude
 * Code's ~120s ceiling, get backgrounded, and abandon any pending elicitation —
 * the exact hang this project exists to fix (PLAN §5). `status` (the
 * `codex_status` tool) touches no I/O at all: it is a map read of whatever the
 * pump last wrote.
 */
import type { AppServerConn } from "./codex.ts";
import type { RunHandle, RunRecord } from "./model.ts";
import type { ThreadStartParams } from "../generated/codex-protocol/ts/v2/ThreadStartParams.ts";
import type { ThreadStartResponse } from "../generated/codex-protocol/ts/v2/ThreadStartResponse.ts";
import type { TurnStartResponse } from "../generated/codex-protocol/ts/v2/TurnStartResponse.ts";

/** A read-only snapshot of a run, as `codex_status` returns it. */
export type RunSnapshot = Readonly<RunRecord>;

export class ThreadRuns {
  /** Keyed by thread id, which is also the handle. The pump looks runs up the same way. */
  private readonly runs = new Map<RunHandle, RunRecord>();

  constructor(
    private readonly conn: AppServerConn,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Start a Codex run and return its handle without waiting for it to finish.
   *
   * For this slice the thread's policy is fixed to something that will actually
   * trigger an approval — `approvalPolicy: "on-request"` under a `workspace-write`
   * sandbox — so the bridge under test has a real approval to answer. Settings
   * mirroring (reading Claude's own posture) is roadmap step 2 and slots in here
   * as the params passed to `thread/start`, not a rewrite.
   */
  async start(prompt: string, cwd: string): Promise<RunHandle> {
    const params: ThreadStartParams = { cwd, approvalPolicy: "on-request", sandbox: "workspace-write" };
    const thread = (await this.conn.request("thread/start", params)) as ThreadStartResponse;
    const handle = thread.thread.id;

    this.runs.set(handle, { handle, status: "starting" });

    // Kick the turn off; do NOT await its completion. The pump drives it from
    // here via the notification stream. A failure to even start the turn is
    // recorded on the run rather than thrown, since the caller has already been
    // promised a handle.
    void this.conn
      .request("turn/start", { threadId: handle, input: [{ type: "text", text: prompt, text_elements: [] }] })
      .then((response) => {
        const turn = response as TurnStartResponse;
        const run = this.runs.get(handle);
        if (run && run.status === "starting") run.status = "running";
        return turn;
      })
      .catch((error: unknown) => {
        this.fail(handle, `failed to start turn: ${(error as Error).message}`);
      });

    return handle;
  }

  /** The current snapshot of a run, or undefined for an unknown handle. No I/O. */
  status(handle: RunHandle): RunSnapshot | undefined {
    return this.runs.get(handle);
  }

  /** The live record for the pump to mutate, or undefined if the handle is unknown. */
  record(handle: RunHandle): RunRecord | undefined {
    return this.runs.get(handle);
  }

  /** All live handles, for the pump to route a notification it can't otherwise place. */
  handles(): readonly RunHandle[] {
    return [...this.runs.keys()];
  }

  private fail(handle: RunHandle, message: string): void {
    const run = this.runs.get(handle);
    if (run) {
      run.status = "error";
      run.error = message;
    }
  }
}
