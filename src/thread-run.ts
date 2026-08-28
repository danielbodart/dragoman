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
import { mirror, resolveMode } from "./mirror.ts";
import { readSettings, type EffectiveSettings } from "./settings.ts";
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
  private conn?: AppServerConn;
  private connecting?: Promise<AppServerConn>;

  /**
   * Takes a `connect` thunk rather than a live connection, so the codex
   * subprocess is spawned lazily on the first `start()` — not at MCP startup.
   * That keeps the MCP server responsive to `initialize`/`tools/list`
   * immediately, and means a missing/broken codex only fails a `codex_run`
   * call (surfaced to that tool), never the whole server. `onConnect` lets the
   * composition root wire the pump onto the connection the moment it exists.
   */
  constructor(
    private readonly connect: () => Promise<AppServerConn>,
    private readonly onConnect: (conn: AppServerConn) => void = () => {},
    private readonly now: () => number = Date.now,
    /** Injectable so the mirror is tested against fixture settings, not the real disk. */
    private readonly readSettings: () => EffectiveSettings = () => readSettings(),
  ) {}

  /** Connect once, memoized — concurrent first calls share one in-flight connect. */
  private async connection(): Promise<AppServerConn> {
    if (this.conn) return this.conn;
    if (!this.connecting) {
      this.connecting = this.connect().then((conn) => {
        this.conn = conn;
        this.onConnect(conn);
        return conn;
      });
    }
    return this.connecting;
  }

  /**
   * Start a Codex run and return its handle without waiting for it to finish.
   *
   * The thread's policy MIRRORS Claude (PLAN §10): the merged Claude settings and
   * the resolved posture (an explicit `posture` Claude passed ?? the static
   * `defaultMode` ?? a safe default) map to Codex's approval + sandbox knobs.
   * `thread/start` takes the enum `sandbox`; the structured `sandboxPolicy`
   * (carrying writable roots + network) rides on `turn/start`, where the object
   * form is accepted.
   */
  async start(prompt: string, cwd: string, posture?: string): Promise<RunHandle> {
    const conn = await this.connection();
    const settings = this.readSettings();
    const mode = resolveMode(settings, posture);
    const policy = mirror(settings, mode, cwd);

    const params: ThreadStartParams = { cwd, approvalPolicy: policy.approvalPolicy, sandbox: policy.sandbox };
    const thread = (await conn.request("thread/start", params)) as ThreadStartResponse;
    const handle = thread.thread.id;

    this.runs.set(handle, { handle, status: "starting" });

    // Kick the turn off; do NOT await its completion. The pump drives it from
    // here via the notification stream. A failure to even start the turn is
    // recorded on the run rather than thrown, since the caller has already been
    // promised a handle. The structured sandboxPolicy (writable roots, network)
    // rides here, where Codex accepts the object form.
    void conn
      .request("turn/start", {
        threadId: handle,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        approvalPolicy: policy.approvalPolicy,
        sandboxPolicy: policy.sandboxPolicy,
      })
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
    // Only fail a run still in its opening phase. A late-settling turn/start
    // rejection must not stomp a run the pump has already legitimately advanced
    // (to waiting-approval, or even done via notifications) back to error —
    // mirroring the same guard the success path uses ("starting" -> "running").
    if (run && (run.status === "starting" || run.status === "running")) {
      run.status = "error";
      run.error = message;
    }
  }
}
