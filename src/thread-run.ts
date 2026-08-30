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
import type { RunEvent, RunHandle, RunRecord } from "./model.ts";
import type { ThreadStartParams } from "../generated/codex-protocol/ts/v2/ThreadStartParams.ts";
import type { ThreadResumeParams } from "../generated/codex-protocol/ts/v2/ThreadResumeParams.ts";
import type { ThreadStartResponse } from "../generated/codex-protocol/ts/v2/ThreadStartResponse.ts";
import type { ThreadResumeResponse } from "../generated/codex-protocol/ts/v2/ThreadResumeResponse.ts";
import type { TurnStartResponse } from "../generated/codex-protocol/ts/v2/TurnStartResponse.ts";
import type { TurnSteerResponse } from "../generated/codex-protocol/ts/v2/TurnSteerResponse.ts";

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
   * (docs/DESIGN.md: per-run spawn; caching is a later decorator). Codex
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
    // Compile (pure) → provision (IO): a fresh app-server whose config mirrors the
    // settings read right now. Shared with `continueRun`, which resumes instead.
    const { settings, policy, provisioned, conn } = await this.provisionMirror(posture);

    // The thread's policy params (profile + writable roots, or the danger sandbox).
    const params = this.mirrorParams(policy, settings, cwd) as ThreadStartParams;
    const thread = (await conn.request("thread/start", params)) as ThreadStartResponse;
    const handle = thread.thread.id;

    this.register(handle, cwd, policy, provisioned);
    // Kick the opening turn off in the background — `thread.model`/`reasoningEffort`
    // feed the native-plan collaboration mode (see `kickTurn`).
    this.kickTurn(handle, conn, policy, prompt, thread.model, thread.reasoningEffort);
    return handle;
  }

  /**
   * Continue a settled thread with a new prompt (the `codex_continue` tool).
   *
   * A continuation is provisioned EXACTLY like a new run — fresh settings read,
   * fresh `mirror`, fresh isolated home — so its policy reflects the mode you are
   * in *now*, not the one the original run started under. It then `thread/resume`s
   * the persisted thread by id (Codex keeps the rollout on disk; `ThreadResumeParams`
   * is a superset of the thread/start knobs, so the same mirror output applies) and
   * starts a new turn. The handle is unchanged, so `codex_status` keeps working.
   */
  async continueRun(handle: RunHandle, prompt: string, posture?: string): Promise<string> {
    const prior = this.runs.get(handle);
    if (!prior) return `No Codex task with handle "${handle}".`;
    // A live run still owns its app-server — resuming would fork it. Steer instead.
    if (this.provisioned.has(handle)) return `Codex task "${handle}" is still running — steer it instead of continuing.`;
    const cwd = prior.cwd;
    if (!cwd) return `Codex task "${handle}" cannot be continued (no recorded working directory).`;

    const { settings, policy, provisioned, conn } = await this.provisionMirror(posture);
    const resumeParams = { threadId: handle, ...this.mirrorParams(policy, settings, cwd) } as ThreadResumeParams;
    const resumed = (await conn.request("thread/resume", resumeParams)) as ThreadResumeResponse;

    this.register(handle, cwd, policy, provisioned);
    this.kickTurn(handle, conn, policy, prompt, resumed.model, resumed.reasoningEffort);
    return `Continuing Codex task "${handle}". Poll codex_status with the same handle.`;
  }

  /**
   * Interrupt a run's active turn (the `codex_cancel` tool).
   *
   * Fire-and-return like the tools it sits beside: `turn/interrupt` needs only the
   * thread + the active turn id (both on the record), and the pump folds the
   * resulting `interrupted` turn into terminal state, so the caller confirms via a
   * normal `codex_status` poll rather than this call blocking on the stop.
   */
  async cancel(handle: RunHandle): Promise<string> {
    const run = this.runs.get(handle);
    if (!run) return `No Codex task with handle "${handle}".`;
    if (run.status === "done" || run.status === "error") {
      return `Codex task "${handle}" has already finished — nothing to cancel.`;
    }
    const conn = this.provisioned.get(handle)?.conn;
    if (!conn || !run.turnId) return `Codex task "${handle}" has no active turn to cancel.`;
    await conn.request("turn/interrupt", { threadId: handle, turnId: run.turnId });
    return `Requested cancel of Codex task "${handle}". Poll codex_status to confirm it stopped.`;
  }

  /**
   * Inject guidance into a run's in-flight turn without interrupting it (the
   * `codex_steer` tool).
   *
   * `expectedTurnId` is a hard precondition on the server: it fails the request if
   * the turn has already moved on, rather than steering the wrong turn. So a
   * rejection is expected, not exceptional — it is reported as a status line the
   * caller can act on (poll and retry), never thrown. The reply carries the (possibly
   * new) turn id, which we adopt.
   */
  async steer(handle: RunHandle, text: string): Promise<string> {
    const run = this.runs.get(handle);
    if (!run) return `No Codex task with handle "${handle}".`;
    if (run.status === "done" || run.status === "error") {
      return `Codex task "${handle}" has already finished — nothing to steer.`;
    }
    const conn = this.provisioned.get(handle)?.conn;
    if (!conn || !run.turnId) return `Codex task "${handle}" has no active turn to steer.`;
    try {
      const response = (await conn.request("turn/steer", {
        threadId: handle,
        input: [{ type: "text", text, text_elements: [] }],
        expectedTurnId: run.turnId,
      })) as TurnSteerResponse;
      run.turnId = response.turnId;
      this.bump(handle);
      return `Steered Codex task "${handle}". Poll codex_status to see it take effect.`;
    } catch (error) {
      return `Could not steer Codex task "${handle}": ${(error as Error).message}. It may have moved past the turn — poll codex_status.`;
    }
  }

  /**
   * Compile Claude's live settings into a fresh Codex policy and provision an
   * app-server for it — the shared compile→provision opening of both a new run
   * (`start`) and a continuation (`continueRun`). Wires the pump onto the new conn.
   */
  private async provisionMirror(
    posture?: string,
  ): Promise<{ settings: EffectiveSettings; policy: CodexPolicy; provisioned: Provisioned; conn: AppServerConn }> {
    const settings = this.readSettings();
    const mode = resolveMode(settings, posture);
    const policy = mirror(settings, mode);
    const provisioned = await this.provision(policy);
    this.onConn(provisioned.conn); // wire the pump onto this run's connection
    return { settings, policy, provisioned, conn: provisioned.conn };
  }

  /**
   * The thread-policy params shared by `thread/start` and `thread/resume`.
   *
   * The permission profile (in the isolated CODEX_HOME config) is the unified scope
   * + network axis; writable roots ride the first-class `runtimeWorkspaceRoots` param
   * (cwd + Claude's additionalDirectories), orthogonal to the profile. `sandbox` is
   * NOT sent with a profile — mutually exclusive. The one exception is the danger
   * posture (no profile), which uses the `danger-full-access` sandbox enum directly.
   * `ThreadResumeParams` is a superset of these knobs, so a continuation reuses this
   * exact mirror output (plus its `threadId`).
   */
  private mirrorParams(policy: CodexPolicy, settings: EffectiveSettings, cwd: string) {
    const reviewer = policy.approvalsReviewer ? { approvalsReviewer: policy.approvalsReviewer } : {};
    return policy.profile
      ? {
          cwd,
          approvalPolicy: policy.approvalPolicy,
          ...reviewer,
          permissions: policy.profile.id,
          runtimeWorkspaceRoots: [cwd, ...settings.additionalDirectories],
        }
      : { cwd, approvalPolicy: policy.approvalPolicy, ...reviewer, sandbox: "danger-full-access" as const };
  }

  /** Record a freshly-provisioned run (new or continued): its live conn (torn down
   * when it settles) and a starting snapshot. Continuation resets the record, so the
   * stale `turnId` is cleared until the new turn's kick-off reply refreshes it. */
  private register(handle: RunHandle, cwd: string, policy: CodexPolicy, provisioned: Provisioned): void {
    this.provisioned.set(handle, provisioned);
    this.runs.set(handle, {
      handle,
      cwd,
      status: "starting",
      events: [],
      execpolicyAmendments: policy.execpolicyAmendments,
      denyPrefixes: policy.denyPrefixes,
      commandFallback: policy.commandFallback,
      fileChange: policy.fileChange,
    });
    this.bump(handle);
  }

  /**
   * Kick a turn off in the background; do NOT await its completion — the pump drives
   * it from the notification stream. A failure to even start the turn is recorded on
   * the run rather than thrown, since `start` has already promised a handle.
   *
   * Native plan mode (Claude's `plan`) rides the collaboration mode here: its
   * `settings.model` is REQUIRED and overrides the model, so we echo back the model
   * Codex just resolved for this thread (not changing it) plus its reasoning effort;
   * `developer_instructions: null` means "use Codex's built-in plan instructions".
   * The active turn id is captured from the reply so a cancel/steer arriving before
   * the first `turn/started` notification already has its precondition.
   */
  private kickTurn(
    handle: RunHandle,
    conn: AppServerConn,
    policy: CodexPolicy,
    prompt: string,
    model: string,
    reasoningEffort: ThreadStartResponse["reasoningEffort"],
  ): void {
    const reviewer = policy.approvalsReviewer ? { approvalsReviewer: policy.approvalsReviewer } : {};
    const collaborationMode = policy.collaborationMode
      ? {
          collaborationMode: {
            mode: policy.collaborationMode,
            settings: { model, reasoning_effort: reasoningEffort, developer_instructions: null },
          },
        }
      : {};
    void conn
      .request("turn/start", {
        threadId: handle,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        approvalPolicy: policy.approvalPolicy,
        ...reviewer,
        // Profile threads re-assert their profile per turn; the danger thread
        // inherits its sandbox from thread/start (nothing to override here).
        ...(policy.profile ? { permissions: policy.profile.id } : {}),
        ...collaborationMode,
      })
      .then((response) => {
        const turn = response as TurnStartResponse;
        const run = this.runs.get(handle);
        if (run) {
          if (run.status === "starting") run.status = "running";
          run.turnId = turn.turn.id;
        }
        this.bump(handle);
        return turn;
      })
      .catch((error: unknown) => {
        this.fail(handle, `failed to start turn: ${(error as Error).message}`);
      });
  }

  /** The current snapshot of a run, or undefined for an unknown handle. No I/O. */
  status(handle: RunHandle): RunSnapshot | undefined {
    return this.runs.get(handle);
  }

  /**
   * Append one event to a run's timeline — the SINGLE entry point every inbound
   * source uses (the notification loop, the approval handler, a Codex note, the
   * terminal outcome). Push-only: the caller `bump`s once it has finished mutating
   * the run, so a burst folds into one wake. Unknown handle → no-op.
   */
  append(handle: RunHandle, event: RunEvent): void {
    this.runs.get(handle)?.events.push(event);
  }

  /** Whether a run has events the caller hasn't been shown yet — the fast-path
   * signal that `codex_status` has something to return without parking. */
  hasPending(handle: RunHandle): boolean {
    return (this.runs.get(handle)?.events.length ?? 0) > 0;
  }

  /**
   * Remove and return a run's undelivered events, oldest first — the drain that
   * makes the timeline a lossless sequence. Each event is handed out exactly once;
   * a superseded one rides here rather than being clobbered by the next. Empty
   * (never undefined) for an unknown or quiet run.
   */
  drain(handle: RunHandle): readonly RunEvent[] {
    const run = this.runs.get(handle);
    if (!run || run.events.length === 0) return [];
    const drained = run.events;
    run.events = [];
    return drained;
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
      this.append(handle, { at: this.now(), kind: "error", text: message });
      this.bump(handle);
    }
  }
}
