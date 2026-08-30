/**
 * Dragoman's own vocabulary — the small data shapes the bridge passes around,
 * independent of both wire protocols (Codex's app-server and MCP). The generated
 * Codex types live under generated/codex-protocol/; these are ours.
 */

/**
 * A single coarse status line — one milestone in a Codex run.
 *
 * The heartbeat design (PLAN §6) is "a filter, not a pipe": the firehose of
 * ~80 notification types is collapsed to a sparse sequence of these. Each beat
 * is buffered (`pendingBeats`) and delivered to the caller exactly once, in
 * order — so a milestone that is instantly superseded (an auto-approval landing
 * between a command's `running:` and `ran:`) is never silently dropped at the
 * polling boundary. A beat is a milestone, not a log line.
 */
export interface Beat {
  /** When Codex emitted the notification this beat came from (ms), or our clock. */
  readonly at: number;
  /** The human-facing one-liner, e.g. "running: cargo test" or "editing 2 file(s)". */
  readonly text: string;
}

/**
 * One entry in a run's single timeline — the unified message log.
 *
 * Everything a run wants to tell the caller is ONE of these, regardless of which
 * inbound channel produced it: a progress milestone from the notification feed, an
 * approval raised/resolved by the server-request handler, a note from Codex, or the
 * terminal outcome. All producers `append` a `RunEvent`; `codex_status` drains the
 * log and renders it — so a new source can never reintroduce the "we dropped that
 * one" bug, because there is exactly one place state is kept (docs/archive/peer-agent-lifecycle.md: the
 * back-channel table). `kind` distinguishes the terminal outcome ("Done. …" /
 * "Errored …") from in-flight entries so the renderer can phrase it, and marks a
 * `message` — Codex's own words mid-run, its back-channel to the driving agent —
 * apart from a `progress` milestone (a tool step). In-flight entries (`progress`,
 * `message`) render the same; the split lets a consumer tell "Codex said X" from
 * "ran: X".
 */
export type RunEventKind = "progress" | "message" | "result" | "error";

export interface RunEvent {
  /** When the source emitted this (ms), or our clock. */
  readonly at: number;
  /** What the entry is: a `progress` milestone, a `message` from Codex, or the
   * terminal `result`/`error`. In-flight kinds render alike. */
  readonly kind: RunEventKind;
  /** The human-facing one-liner. */
  readonly text: string;
}

/** Opaque handle `codex_run` returns and `codex_status` takes. Currently a thread id. */
export type RunHandle = string;

/**
 * Where a run is in its lifecycle, as `codex_status` reports it.
 *
 * `waiting-approval` is the state that makes this whole project exist: Codex has
 * asked to do something the mirrored policy can't auto-answer, an elicitation is
 * in front of the user, and the run is parked — not hung — until they respond.
 */
export type RunStatus = "starting" | "running" | "waiting-approval" | "done" | "error";

/**
 * The bridge's live record of one Codex run.
 *
 * The background pump mutates this as notifications arrive; `codex_status` reads
 * it with no I/O at all. Two kinds of state, deliberately separated:
 *
 *  - `status` — the persistent CONTROL scalar (latest-wins, safe to overwrite): the
 *    O(1) "is it running / waiting / done?" the long-poll needs to decide whether to
 *    park and the caller needs to decide whether to stop.
 *  - `events` — the append-only MESSAGE log (never overwritten, drained once): every
 *    milestone, approval, note and terminal outcome, from every inbound channel, in
 *    order. This is the single place run output is kept, so no source can drop
 *    another's message at the polling boundary. The firehose between milestones is
 *    still dropped by construction (never becomes an event).
 */
export interface RunRecord {
  readonly handle: RunHandle;
  /** The working directory the run was started in. Retained so `codex_continue`
   * can resume the thread and re-mirror against the same cwd + writable roots. */
  readonly cwd?: string;
  /** Command token prefixes Claude would allow without prompting. */
  readonly execpolicyAmendments?: readonly (readonly string[])[];
  /** Command token prefixes Claude would deny — pre-declined without prompting. */
  readonly denyPrefixes?: readonly (readonly string[])[];
  /** What to do with a command approval no allow/deny prefix settles: ask the human
   * (`elicit`, default) or refuse without asking (`decline`, for `dontAsk`). */
  readonly commandFallback?: "elicit" | "decline";
  /** What to do with a file-edit approval: ask (`elicit`), auto-approve (`accept`,
   * for `acceptEdits`), or refuse (`decline`, for `dontAsk`). */
  readonly fileChange?: "elicit" | "accept" | "decline";
  status: RunStatus;
  /** The active turn's id (Codex UUIDv7), refreshed on every `turn/started`.
   * The precondition `turn/interrupt` and `turn/steer` both require — captured
   * here so a cancel/steer/continue tool can name the turn without a round-trip —
   * and surfaced by `diagnostics` as the live view of what each run is doing. */
  turnId?: string;
  /** The single append-only timeline (see the type doc): every producer appends, and
   * `codex_status` drains it in order. The terminal outcome is the last event of kind
   * `result`/`error` — not a special field — so nothing here is delivered specially. */
  events: RunEvent[];
}
