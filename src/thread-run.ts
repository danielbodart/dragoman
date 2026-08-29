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
import { mirror, resolveMode, type CodexPolicy } from "./mirror.ts";
import { readSettings as readSettingsFromDisk, type EffectiveSettings } from "./settings.ts";
import type { AppServerConn } from "./codex.ts";
import type { RunHandle, RunRecord } from "./model.ts";
import type { ThreadStartParams } from "../generated/codex-protocol/ts/v2/ThreadStartParams.ts";
import type { ThreadStartResponse } from "../generated/codex-protocol/ts/v2/ThreadStartResponse.ts";
import type { TurnStartResponse } from "../generated/codex-protocol/ts/v2/TurnStartResponse.ts";

/** A read-only snapshot of a run, as `codex_status` returns it. */
export type RunSnapshot = Readonly<RunRecord>;

/**
 * A freshly provisioned app-server for one run: the connection plus an optional
 * `cleanup` the caller runs once the run settles (e.g. remove the per-run
 * isolated CODEX_HOME). Provisioning is the IO seam — it writes the compiled
 * config to disk and spawns codex — kept OUT of this class (which stays pure of
 * the filesystem) and out of `compile` (`mirror`, which is pure of everything).
 */
export interface Provisioned {
  readonly conn: AppServerConn;
  readonly cleanup?: () => void;
}

export class ThreadRuns {
  /** Keyed by thread id, which is also the handle. The pump looks runs up the same way. */
  private readonly runs = new Map<RunHandle, RunRecord>();
  /** Per-run revision counter and long-poll waiters, driving `waitForUpdate`. */
  private readonly revisions = new Map<RunHandle, number>();
  private readonly waiters = new Map<RunHandle, Array<() => void>>();
  /** The live app-server behind each run, torn down when the run settles. */
  private readonly provisioned = new Map<RunHandle, Provisioned>();

  /**
   * `provision` spawns a FRESH app-server per run from the compiled policy — so
   * every run's Codex config is generated from the settings read at that moment
   * (docs/POLICY-COMPILER.md: per-run spawn; caching is a later decorator). Codex
   * is not touched until the first `start()`, keeping the MCP server responsive to
   * `initialize`/`tools/list` and letting a broken codex fail only a `codex_run`
   * call. `onConn` wires the pump onto each new connection.
   */
  constructor(
    private readonly provision: (policy: CodexPolicy) => Promise<Provisioned>,
    private readonly onConn: (conn: AppServerConn) => void = () => {},
    private readonly now: () => number = Date.now,
    /** Injectable so the mirror is tested against fixture settings, not the real disk. */
    private readonly readSettings: () => EffectiveSettings = readSettingsFromDisk,
  ) {}

  /** Close every live app-server and run its cleanup — for process shutdown. */
  closeAll(): void {
    for (const handle of [...this.provisioned.keys()]) this.dispose(handle);
  }

  /** Tear down the app-server behind a settled run. Idempotent. */
  private dispose(handle: RunHandle): void {
    const p = this.provisioned.get(handle);
    if (!p) return;
    this.provisioned.delete(handle);
    // `cleanup` (from the provision seam) owns the teardown: close the connection
    // AND remove the run's isolated home. Keeping it there leaves this class free
    // of both the concrete connection type and the filesystem.
    try {
      p.cleanup?.();
    } catch {
      // best-effort teardown — a failed cleanup must never break status/bump
    }
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
    // Compile (pure): merged settings + resolved mode → the Codex policy for THIS
    // run. Then provision (IO): a fresh app-server whose config is that policy.
    const settings = this.readSettings();
    const mode = resolveMode(settings, posture);
    const policy = mirror(settings, mode);
    const provisioned = await this.provision(policy);
    const conn = provisioned.conn;
    this.onConn(conn); // wire the pump onto this run's connection

    // The permission profile (in the isolated CODEX_HOME config) is the unified
    // scope + network axis; writable roots ride the first-class runtimeWorkspaceRoots
    // param (cwd + Claude's additionalDirectories), which is orthogonal to the
    // profile. `sandbox` is NOT sent with a profile — they are mutually exclusive.
    // The one exception is the danger posture (no profile), which uses the
    // `danger-full-access` sandbox enum directly (it means "no sandbox" anyway).
    // Who adjudicates escalations (auto → auto_review); orthogonal to the policy.
    const reviewer = policy.approvalsReviewer ? { approvalsReviewer: policy.approvalsReviewer } : {};
    const params: ThreadStartParams = policy.profile
      ? {
          cwd,
          approvalPolicy: policy.approvalPolicy,
          ...reviewer,
          permissions: policy.profile.id,
          runtimeWorkspaceRoots: [cwd, ...settings.additionalDirectories],
        }
      : { cwd, approvalPolicy: policy.approvalPolicy, ...reviewer, sandbox: "danger-full-access" };
    const thread = (await conn.request("thread/start", params)) as ThreadStartResponse;
    const handle = thread.thread.id;

    this.provisioned.set(handle, provisioned); // torn down when the run settles
    this.runs.set(handle, {
      handle,
      status: "starting",
      execpolicyAmendments: policy.execpolicyAmendments,
      denyPrefixes: policy.denyPrefixes,
    });
    this.bump(handle);

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
        ...reviewer,
        // Profile threads re-assert their profile per turn; the danger thread
        // inherits its sandbox from thread/start (nothing to override here).
        ...(policy.profile ? { permissions: policy.profile.id } : {}),
      })
      .then((response) => {
        const turn = response as TurnStartResponse;
        const run = this.runs.get(handle);
        if (run && run.status === "starting") run.status = "running";
        this.bump(handle);
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

  /**
   * Bump a run's revision and wake any long-poll waiters — called after every
   * mutation of a run. The write itself is the wake signal, so a blocked poll
   * returns the instant something changes.
   */
  bump(handle: RunHandle): void {
    this.revisions.set(handle, this.revision(handle) + 1);
    const waiters = this.waiters.get(handle);
    if (waiters && waiters.length > 0) {
      this.waiters.set(handle, []);
      for (const resume of waiters) resume();
    }
    // A settled run's app-server has done its job — tear it down (per-run spawn
    // means one process per run). The run RECORD stays so `codex_status` can still
    // report the final snapshot; only the connection + its home are released.
    const run = this.runs.get(handle);
    if (run && (run.status === "done" || run.status === "error")) this.dispose(handle);
  }

  /** A run's current revision — 0 until its first mutation. */
  revision(handle: RunHandle): number {
    return this.revisions.get(handle) ?? 0;
  }

  /**
   * Long-poll a run: resolve as soon as it advances past `since` (or is already
   * terminal), else park until it does or `timeoutMs` elapses — returning the
   * latest snapshot and revision either way.
   *
   * This is the event-driven replacement for interval polling (PLAN §6): the MCP
   * `codex_status` tool blocks on this, so it returns the moment the pump writes
   * a beat / a pending approval / a terminal status, and makes ZERO calls while a
   * run sits quiet — where a fixed-interval poller keeps firing on its timer.
   * Capped below Claude Code's ~120s tool ceiling so a long quiet run returns
   * "still running, call again" rather than being backgrounded.
   */
  async waitForUpdate(
    handle: RunHandle,
    since: number,
    timeoutMs: number,
  ): Promise<{ snapshot: RunSnapshot | undefined; revision: number }> {
    const isTerminal = (s: RunSnapshot | undefined) => s?.status === "done" || s?.status === "error";
    if (this.revision(handle) > since || isTerminal(this.status(handle))) {
      return { snapshot: this.status(handle), revision: this.revision(handle) };
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      const list = this.waiters.get(handle) ?? [];
      list.push(() => {
        clearTimeout(timer);
        resolve();
      });
      this.waiters.set(handle, list);
    });
    return { snapshot: this.status(handle), revision: this.revision(handle) };
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
      this.bump(handle);
    }
  }
}
