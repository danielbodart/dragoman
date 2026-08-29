/**
 * The background pump — the async heart of the bridge.
 *
 * Two independent jobs, both wired here and both kept alive by the event loop
 * for the life of the process, neither on the critical path of an MCP tool call:
 *
 *  1. The approval handler (`onServerRequest`): a server→client approval request
 *     becomes an `ElicitationChannel.ask`, and the chosen decision is returned —
 *     which is how the reply reaches Codex (the handler's resolved value IS the
 *     reply). This handler may take as long as the human does; that is fine,
 *     because it is driven by Codex's own request/response RPC, which has no
 *     Claude-Code deadline. What must never happen is this stalling the
 *     notification loop — the AppServerConn transport keeps reading the socket
 *     while the handler's promise is pending, which is the whole fix for the
 *     official plugin's synchronous `-32601` hang (PLAN §5).
 *
 *  2. The notification loop: one `for await` over the feed, folding each
 *     notification through the pure `beatOf` filter and overwriting the matching
 *     run's `latestBeat`. Overwrite, not append — that is the "sparse heartbeat"
 *     (PLAN §6); the firehose in between is dropped by construction.
 */
import { beatOf, threadIdOf } from "./heartbeat.ts";
import type { AppServerConn, Notification, ServerRequest } from "./codex.ts";
import type { ElicitationChannel } from "./elicitation.ts";
import type { RunRecord } from "./model.ts";
import type { ThreadRuns } from "./thread-run.ts";
import type { CommandExecutionRequestApprovalParams } from "../generated/codex-protocol/ts/v2/CommandExecutionRequestApprovalParams.ts";

/**
 * Wire the pump onto a connection: register the approval handler and start the
 * notification loop. Returns the loop promise (kept alive by the caller, not
 * awaited on the critical path) and stops cleanly when `signal` aborts.
 */
export function startPump(
  conn: AppServerConn,
  runs: ThreadRuns,
  elicitation: ElicitationChannel,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  conn.onServerRequest((request) => handleServerRequest(request, runs, elicitation));
  return runNotifications(conn, runs, options.signal);
}

/**
 * Answer one server→client request.
 *
 * Every reply must be the shape the SERVER expects for that method (each
 * `ServerRequest` variant has its own response type in the generated protocol),
 * so a single blanket `{decision: "decline"}` is wrong — for host-service
 * requests it is a malformed result that could break Codex, and the legacy
 * approval methods don't even have a `"decline"` variant. So we dispatch:
 *
 *  - command / file-change approvals → a correctly-typed `{decision}` reply
 *    (a mirrored command allow-prefix answers automatically; other commands
 *    route through the human; file-change declines for now, which is
 *    `FileChangeApprovalDecision`'s valid "no").
 *  - `currentTime/read` → the real time; it's a host service, not an approval,
 *    trivial and safe to answer correctly.
 *  - everything else (permissions, tool-call/user-input, mcp elicitation
 *    passthrough, auth/attestation host services, legacy approval methods) →
 *    THROW, so the transport sends a well-formed JSON-RPC error frame. An error
 *    is a valid response the server can act on; a wrong-shaped `result` is not.
 *    Answering these properly is future work, but erroring is protocol-correct
 *    and still never leaves the request unanswered (never hangs).
 */
async function handleServerRequest(
  request: ServerRequest,
  runs: ThreadRuns,
  elicitation: ElicitationChannel,
): Promise<unknown> {
  switch (request.method) {
    case "item/commandExecution/requestApproval":
      return handleCommandApproval(request.params, runs, elicitation);
    case "item/fileChange/requestApproval":
      // A real, correctly-typed decline (FileChangeApprovalDecision). Surfacing
      // this as an elicitation too is the natural next step.
      return { decision: "decline" };
    case "currentTime/read":
      return { currentTimeAt: Math.floor(Date.now() / 1000) };
    default:
      throw new Error(`unsupported server request: ${request.method}`);
  }
}

/** Command-execution approval: mirror allow-prefixes, then route the rest through the human. */
async function handleCommandApproval(
  params: CommandExecutionRequestApprovalParams,
  runs: ThreadRuns,
  elicitation: ElicitationChannel,
): Promise<unknown> {
  const run = runs.record(params.threadId);

  // Deny wins over allow (Claude's own precedence). Fail closed: a denied
  // prefix blocks even when hidden in a shell wrapper or chained after another
  // command, so it is matched against every segment, not just a lone command.
  if (isDenied(params, run?.denyPrefixes ?? [])) return { decision: "decline" };

  const amendment = matchesPrefix(params, run?.execpolicyAmendments ?? []);
  if (amendment) {
    if (run?.status === "waiting-approval") run.status = "running";
    return { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } } };
  }

  if (run) run.status = "waiting-approval";

  const decisions = availableDecisions(params);
  const decision = await elicitation.ask({ prompt: promptFor(params), decisions });

  // The turn resumes once Codex has the decision; move back off the waiting
  // state so `codex_status` stops reporting a pending approval. A later
  // notification will refine this (running again, or done).
  if (run && run.status === "waiting-approval") run.status = "running";

  return { decision };
}

/** Return the matching non-empty command-token prefix, if any. */
function matchesPrefix(
  params: CommandExecutionRequestApprovalParams,
  prefixes: readonly (readonly string[])[],
): readonly string[] | undefined {
  for (const tokens of commandTokenCandidates(params)) {
    for (const prefix of prefixes) {
      if (isTokenPrefix(prefix, tokens)) return prefix;
    }
  }
  return undefined;
}

/**
 * The command tokens eligible for an auto-approval match, or none.
 *
 * Only `params.command` is trusted — never Codex's self-proposed
 * `proposedExecpolicyAmendment`, since Codex is the very party this gate
 * mediates: letting its proposed prefix decide "skip the human" would fail open
 * (Codex could propose `npm run test` while actually running `rm -rf /`). We
 * derive the tokens ourselves from the real command string, unwrapping a shell
 * wrapper (`bash -lc '<script>'`) to its inner script first.
 */
function commandTokenCandidates(params: CommandExecutionRequestApprovalParams): readonly (readonly string[])[] {
  const command = params.command?.trim();
  if (!command) return [];

  const source = unwrapShellScript(command) ?? command;
  const tokens = simpleCommandTokens(source);
  return tokens ? [tokens] : [];
}

/**
 * The tokens of a single simple command, or undefined if `source` is anything
 * more — a chain, substitution, redirect, glob, variable, or quoting.
 *
 * Auto-approval covers the WHOLE command, so it must never match a compound
 * command: a benign allow-prefix (`npm run test`) matching the first segment of
 * `npm run test && rm -rf /` would otherwise approve the chained `rm` too. So
 * anything not provably a lone simple command — every token drawn from a
 * conservative safe-character allowlist — falls through to the human instead.
 */
function simpleCommandTokens(source: string): readonly string[] | undefined {
  const tokens = source.trim().split(/\s+/);
  const safe = /^[A-Za-z0-9_./:=@,+-]+$/;
  return tokens.length > 0 && tokens.every((token) => safe.test(token)) ? tokens : undefined;
}

/** True when `tokens` starts with every non-empty `prefix` token in order. */
function isTokenPrefix(prefix: readonly string[], tokens: readonly string[]): boolean {
  return prefix.length > 0 && prefix.every((token, index) => tokens[index] === token);
}

/**
 * True when any segment of the command begins with a denied prefix.
 *
 * The inverse conservatism of the allow path: allow matches only a lone simple
 * command (§`simpleCommandTokens`), but deny is fail-closed — it must still fire
 * when a denied command is wrapped in a shell (`bash -lc '...'`), chained after
 * another (`ok && curl evil`), or preceded by inline env assignments
 * (`FOO=1 curl evil`). So every operator-separated segment is checked, after
 * stripping leading `NAME=value` tokens. This mirrors Claude's `deny` as a
 * policy convenience, not as the containment boundary — the sandbox is that; a
 * command that slips this match still faces the mirrored sandbox and, failing
 * that, the normal human prompt (a missed deny falls through, never auto-runs).
 */
function isDenied(
  params: CommandExecutionRequestApprovalParams,
  denyPrefixes: readonly (readonly string[])[],
): boolean {
  if (denyPrefixes.length === 0) return false;
  for (const segment of commandSegments(params)) {
    const command = stripLeadingAssignments(segment);
    for (const prefix of denyPrefixes) {
      if (isTokenPrefix(prefix, command)) return true;
    }
  }
  return false;
}

/** Every operator-separated command segment, unwrapping a shell wrapper first. */
function commandSegments(params: CommandExecutionRequestApprovalParams): readonly (readonly string[])[] {
  const command = params.command?.trim();
  if (!command) return [];
  const script = unwrapShellScript(command) ?? command;
  return script
    .split(/&&|\|\||;|\||&|\n/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.split(/\s+/));
}

/** Drop leading `NAME=value` environment assignments so the real command leads. */
function stripLeadingAssignments(tokens: readonly string[]): readonly string[] {
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_]\w*=/.test(tokens[index]!)) index += 1;
  return tokens.slice(index);
}

/** Extract the script argument from the common non-interactive shell wrappers. */
function unwrapShellScript(command: string): string | undefined {
  const match = command.match(/^(?:sh|bash|\/bin\/sh|\/bin\/bash)\s+(?:-c|-lc|-l\s+-c)\s+(.+)$/);
  if (!match) return undefined;

  const argument = match[1]!.trim();
  const quote = argument[0];
  if (quote === "'" || quote === '"') {
    return argument.length >= 2 && argument.at(-1) === quote ? argument.slice(1, -1) : undefined;
  }
  return /^\S+$/.test(argument) ? argument : undefined;
}

/** The human-facing prompt for a command approval. */
function promptFor(params: CommandExecutionRequestApprovalParams): string {
  const where = params.cwd ? ` in ${params.cwd}` : "";
  const command = params.command ?? "(a command)";
  const reason = params.reason ? ` — ${params.reason}` : "";
  return `Codex wants to run \`${command}\`${where}${reason}`;
}

/**
 * The decision ids to offer, honouring Codex's own `availableDecisions` order
 * when present. Only the string-valued decisions are surfaced for this slice;
 * the amendment variants (execpolicy/network) are objects and are left for the
 * settings/execpolicy work (roadmap step 2).
 */
function availableDecisions(params: CommandExecutionRequestApprovalParams): string[] {
  const offered: string[] = [];
  for (const decision of params.availableDecisions ?? []) {
    if (typeof decision === "string") offered.push(decision);
  }
  return offered.length > 0 ? offered : ["accept", "acceptForSession", "decline"];
}

/** The notification loop: fold each notification into a beat and update run state. */
async function runNotifications(conn: AppServerConn, runs: ThreadRuns, signal?: AbortSignal): Promise<void> {
  for await (const notification of conn.notifications) {
    if (signal?.aborted) return;
    apply(notification, runs);
  }
}

/** Route one notification to its run and fold in its beat / terminal status. */
function apply(notification: Notification, runs: ThreadRuns): void {
  const run = runFor(notification, runs);
  if (!run) return;

  const beat = beatOf(notification);
  if (beat) run.latestBeat = beat;

  if (notification.method === "turn/completed") {
    const turn = notification.params.turn;
    if (turn.status === "failed") {
      run.status = "error";
      run.error = turn.error?.message ?? "turn failed";
    } else {
      run.status = "done";
      run.result = lastAgentMessage(turn) ?? run.result;
    }
  } else if (notification.method === "error") {
    run.status = "error";
    run.error = notification.params.error.message;
  }
}

/**
 * The run a notification belongs to.
 *
 * Most carry a `threadId`; the feed-wide ones (account/app/model housekeeping)
 * do not and are skipped. As a fallback, when there is exactly one live run, an
 * un-threaded-but-run-relevant notification is attributed to it — the common
 * single-run case, without pretending to route what we can't place.
 */
function runFor(notification: Notification, runs: ThreadRuns): RunRecord | undefined {
  const threadId = threadIdOf(notification);
  if (threadId) return runs.record(threadId);
  const handles = runs.handles();
  return handles.length === 1 ? runs.record(handles[0]!) : undefined;
}

/** The final assistant message in a completed turn, if any, as the run's result. */
function lastAgentMessage(turn: { items: readonly { type: string }[] }): string | undefined {
  for (let i = turn.items.length - 1; i >= 0; i--) {
    const item = turn.items[i]!;
    if (item.type === "agentMessage") return (item as { text?: string }).text;
  }
  return undefined;
}
