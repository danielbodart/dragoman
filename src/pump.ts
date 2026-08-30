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
 *     notification through the pure `beatOf` filter and appending the matching
 *     run's beats to `pendingBeats` (with `latestBeat` as the newest snapshot).
 *     The buffer is the "sparse heartbeat" (PLAN §6) — the firehose in between is
 *     dropped by construction (never a beat); codex_status drains it in order, so
 *     no milestone is lost even when two land between polls.
 */
import { beatOf, threadIdOf } from "./heartbeat.ts";
import type { AppServerConn, Notification, ServerRequest } from "./codex.ts";
import type { ElicitationChannel } from "./elicitation.ts";
import type { RunRecord } from "./model.ts";
import type { ThreadRuns } from "./thread-run.ts";
import type { CommandExecutionRequestApprovalParams } from "../generated/codex-protocol/ts/v2/CommandExecutionRequestApprovalParams.ts";
import type { FileChangeRequestApprovalParams } from "../generated/codex-protocol/ts/v2/FileChangeRequestApprovalParams.ts";
import type { PermissionsRequestApprovalParams } from "../generated/codex-protocol/ts/v2/PermissionsRequestApprovalParams.ts";
import type { GrantedPermissionProfile } from "../generated/codex-protocol/ts/v2/GrantedPermissionProfile.ts";

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
 *  - `item/permissions/requestApproval` → the agent asking to WIDEN its sandbox
 *    (add network / filesystem reach) for the rest of the turn; routed to the human
 *    via elicitation like the other approvals.
 *  - everything else (tool-call/user-input, mcp elicitation
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
      return handleFileChangeApproval(request.params, runs, elicitation);
    case "item/permissions/requestApproval":
      return handlePermissionsApproval(request.params, runs, elicitation);
    case "currentTime/read":
      return { currentTimeAt: Math.floor(Date.now() / 1000) };
    default:
      throw new Error(`unsupported server request: ${request.method}`);
  }
}

/**
/**
 * Put a run into the waiting-for-human state AND append a `progress` event, so a
 * pending approval rides the same drained timeline as everything else and is NEVER
 * lost at a polling boundary. The bare `waiting-approval` *status* is a snapshot
 * (latest wins), so a fast answer flips it back to `running` before a coarse poll
 * ever sees it — the missed-feedback bug (a re-prompt because the caller never saw
 * the first). Events drain in order, so they can't be skipped — the same append the
 * notification loop and the terminal outcome use.
 */
function raiseApproval(runs: ThreadRuns, threadId: string, what: string): void {
  const run = runs.record(threadId);
  if (!run) return;
  run.status = "waiting-approval";
  runs.append(threadId, { at: Date.now(), kind: "progress", text: `waiting for your approval: ${what}` });
  runs.bump(threadId);
}

/** Record the human's answer as an event and leave the waiting state. */
function resolveApproval(runs: ThreadRuns, threadId: string, decision: string, what: string): void {
  const run = runs.record(threadId);
  if (!run) return;
  if (run.status === "waiting-approval") run.status = "running";
  const verb = decision === "accept" || decision === "acceptForSession" ? "you approved" : `you chose ${decision} for`;
  runs.append(threadId, { at: Date.now(), kind: "progress", text: `${verb}: ${what}` });
  runs.bump(threadId);
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

  // Nothing pre-answered it. `dontAsk` ("only pre-approved tools") refuses without
  // asking; every other mode routes the decision to the human.
  if (run?.commandFallback === "decline") return { decision: "decline" };

  const what = `run \`${params.command ?? "a command"}\``;
  raiseApproval(runs, params.threadId, what);

  const decisions = availableDecisions(params);
  const decision = await elicitation.ask({ prompt: promptFor(params), decisions });

  // The turn resumes once Codex has the decision; the lossless resolution beat lets a
  // coarse poller see the outcome even though the waiting status has already lifted.
  resolveApproval(runs, params.threadId, decision, what);

  return { decision };
}

/**
 * File-change approval: route through the human, mirroring the command path.
 *
 * Codex raises this when a write escapes its sandbox (e.g. under a judged mode's
 * `granular` policy with reviewer `user`). The mode decides how: `acceptEdits`
 * auto-accepts (Claude auto-approves edits), `dontAsk` refuses, everyone else asks
 * the human. The reply is a `FileChangeApprovalDecision`.
 */
async function handleFileChangeApproval(
  params: FileChangeRequestApprovalParams,
  runs: ThreadRuns,
  elicitation: ElicitationChannel,
): Promise<unknown> {
  const run = runs.record(params.threadId);

  // acceptEdits → auto-approve edits; dontAsk → refuse. Neither waits on a human.
  if (run?.fileChange === "accept") return { decision: "accept" };
  if (run?.fileChange === "decline") return { decision: "decline" };

  const where = params.grantRoot ? ` under \`${params.grantRoot}\`` : "";
  const reason = params.reason ? ` — ${params.reason}` : "";
  const what = `write files${where}`;
  raiseApproval(runs, params.threadId, what);

  const decision = await elicitation.ask({
    prompt: `Codex wants to write files${where}${reason}`,
    decisions: ["accept", "acceptForSession", "decline", "cancel"],
  });
  resolveApproval(runs, params.threadId, decision, what);
  return { decision };
}

/**
 * Permissions request: the agent asks to WIDEN its sandbox — add network access or
 * filesystem paths for the rest of the turn — not to run one action, but for a
 * standing capability. Route it straight to the human via elicitation, showing the
 * reason and exactly what's requested; `accept` grants what was asked (turn scope),
 * anything else grants nothing (an empty profile widens nothing). No intersection with
 * Claude's own rules — the human sees the request and decides. The mode's
 * decline-fallback (`dontAsk`/`plan`) refuses without asking; those modes don't run
 * `granular`, so they never actually raise one, but this keeps the never-prompt
 * contract. Only fires under `granular` (acceptEdits, or auto when the model reviewer
 * defers to the user).
 */
async function handlePermissionsApproval(
  params: PermissionsRequestApprovalParams,
  runs: ThreadRuns,
  elicitation: ElicitationChannel,
): Promise<unknown> {
  const run = runs.record(params.threadId);
  if (run?.commandFallback === "decline") return denyPermissions();

  const what = "expand its permissions";
  raiseApproval(runs, params.threadId, what);
  const decision = await elicitation.ask({ prompt: permissionsPromptFor(params), decisions: ["accept", "decline"] });
  resolveApproval(runs, params.threadId, decision, what);

  if (decision !== "accept") return denyPermissions();
  const requested = params.permissions;
  const granted: GrantedPermissionProfile = {};
  if (requested.network) granted.network = requested.network;
  if (requested.fileSystem) granted.fileSystem = requested.fileSystem;
  return { permissions: granted, scope: "turn" };
}

/** The deny for a capability request: grant an empty profile (widens nothing). */
function denyPermissions(): unknown {
  return { permissions: {}, scope: "turn" };
}

/** A human-readable summary of the reach the agent is asking to be granted. */
function permissionsPromptFor(params: PermissionsRequestApprovalParams): string {
  const wants: string[] = [];
  if (params.permissions.network?.enabled) wants.push("network access");
  const fs = params.permissions.fileSystem;
  if (fs?.write?.length) wants.push(`write: ${fs.write.join(", ")}`);
  if (fs?.read?.length) wants.push(`read: ${fs.read.join(", ")}`);
  if (fs?.entries?.length) wants.push(`${fs.entries.length} path rule(s)`);
  const what = wants.length > 0 ? wants.join("; ") : "expanded permissions";
  const reason = params.reason ? ` — ${params.reason}` : "";
  return `Codex wants to expand its permissions in \`${params.cwd}\`${reason}: ${what}`;
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

  const handle = run.handle;
  const at = notification.emittedAtMs ?? Date.now();
  let changed = false;

  const terminal = notification.method === "turn/completed" || notification.method === "error";

  // Progress milestones from the firehose become `progress` events — EXCEPT the
  // terminal notifications, whose outcome is appended below as its own richer event
  // (so beatOf's coarse "turn complete" doesn't duplicate the result line). Append,
  // don't overwrite: codex_status drains in order, so a beat instantly superseded
  // (an auto-approval between `running:` and `ran:`) is still delivered.
  if (!terminal) {
    const beat = beatOf(notification);
    if (beat) {
      runs.append(handle, { at: beat.at, kind: "progress", text: beat.text });
      changed = true;
    }
  }

  // Codex's own words mid-run — an agentMessage item completing — are its
  // back-channel to the driving agent (docs/archive/peer-agent-lifecycle.md): surface them as `message`
  // events so a note Codex emits reaches the agent on its next poll. The FINAL
  // message also rides turn/completed as the `result`; the dedupe there upgrades a
  // just-streamed final message in place rather than delivering it twice.
  const message = agentMessageOf(notification);
  if (message) {
    runs.append(handle, { at, kind: "message", text: message });
    changed = true;
  }

  if (notification.method === "turn/started") {
    // Track the live turn id (fresh on each turn, incl. continuation turns) so a
    // cancel/steer always names the currently-active turn.
    run.turnId = notification.params.turn.id;
    changed = true;
  }

  if (notification.method === "turn/completed") {
    const turn = notification.params.turn;
    if (turn.status === "failed") {
      run.status = "error";
      runs.append(handle, { at, kind: "error", text: turn.error?.message ?? "turn failed" });
    } else {
      // `completed` or `interrupted` (a cancel) both settle the run; the final
      // assistant message, if any, is the outcome event.
      run.status = "done";
      const result = lastAgentMessage(turn);
      if (result) {
        const tail = run.events.at(-1);
        if (tail && tail.kind === "message" && tail.text === result) {
          // The final message just streamed as a `message` this same poll — reclassify
          // it as the result rather than delivering the same text twice.
          run.events[run.events.length - 1] = { ...tail, kind: "result" };
        } else {
          runs.append(handle, { at, kind: "result", text: result });
        }
      }
    }
    changed = true;
  } else if (notification.method === "error") {
    run.status = "error";
    runs.append(handle, { at, kind: "error", text: notification.params.error.message });
    changed = true;
  }

  // Wake any long-poll waiting on this run — the write itself is the signal.
  if (changed) runs.bump(handle);
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

/**
 * Codex's own message from a completing `agentMessage` item — its mid-run
 * back-channel to the driving agent — or undefined for any other notification.
 * The final one also arrives inside turn/completed as the result; apply() dedupes.
 */
function agentMessageOf(notification: Notification): string | undefined {
  if (notification.method !== "item/completed") return undefined;
  const item = notification.params.item;
  return item.type === "agentMessage" ? item.text ?? undefined : undefined;
}

/** The final assistant message in a completed turn, if any, as the run's result. */
function lastAgentMessage(turn: { items: readonly { type: string }[] }): string | undefined {
  for (let i = turn.items.length - 1; i >= 0; i--) {
    const item = turn.items[i]!;
    if (item.type === "agentMessage") return (item as { text?: string }).text;
  }
  return undefined;
}
