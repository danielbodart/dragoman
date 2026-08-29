/**
 * Dragoman's own vocabulary — the small data shapes the bridge passes around,
 * independent of both wire protocols (Codex's app-server and MCP). The generated
 * Codex types live under generated/codex-protocol/; these are ours.
 */

/**
 * A single coarse status line — one milestone in a Codex run.
 *
 * The heartbeat design (PLAN §6) is "a filter, not a pipe": the firehose of
 * ~80 notification types is collapsed to a sparse sequence of these, and only
 * the *latest* one is retained per run. A beat is a milestone, not a log line.
 */
export interface Beat {
  /** When Codex emitted the notification this beat came from (ms), or our clock. */
  readonly at: number;
  /** The human-facing one-liner, e.g. "running: cargo test" or "editing 2 file(s)". */
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
 * it with no I/O at all. `latestBeat` is overwritten, never appended — that
 * overwrite *is* the "sparse heartbeat" (PLAN §6): the firehose in between is
 * dropped by construction, never stored.
 */
export interface RunRecord {
  readonly handle: RunHandle;
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
  latestBeat?: Beat;
  /** The final assistant message / turn result, once `status` is "done". */
  result?: string;
  /** A human-facing error string, once `status` is "error". */
  error?: string;
}
