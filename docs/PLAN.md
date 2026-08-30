# Plan: the full peer-agent lifecycle

_Status: the foundation, the production `diagnostics` probe, all three lifecycle
tools (`codex_cancel`, `codex_steer`, `codex_continue`), the unified event-log
substrate, the Codex→agent back-channel (mid-run `agentMessage`s as events), and
`codex_review` (Codex's dedicated review pass) have landed — wired into the MCP surface
and covered by `test/lifecycle.test.ts` / `test/pump.test.ts`. Still open: verifying the
`codex-agent` messaging relay end-to-end in a live run. `codex_diff` was dropped (see
Secondary tools)._

## Why

Dragoman exposes two tools — `codex_run` (start) and `codex_status` (follow). That
is only the front half of a run's life. A Codex peer agent today cannot be
**steered**, **interrupted**, or **continued**: the moment a run goes terminal,
`ThreadRuns.bump` disposes its app-server (`thread-run.ts`), so every follow-up is a
cold new thread that re-reads the whole repo, an off-the-rails run can only be
waited out, and a mid-flight nudge has nowhere to go.

The complete peer-agent lifecycle is **start → follow → steer → interrupt →
continue**. This is not five features — it is one feature (a run you are actually in
control of) with three of its five verbs missing. By the combinatorial-completeness
rule, the missing verbs aren't gold-plating; they're the rest of a thing already
half-shipped. The Codex app-server already has the methods; this plan wires them
onto Claude Code the way `codex_run` wired `turn/start`.

Scope discipline holds the line the other way too: of the app-server's ~130
methods, only these belong here. `fs/*`, `process/*`, `command/exec/*`,
`account/*`, `plugin/*`, `marketplace/*`, `skills/*`, `config/*`, `fuzzyFileSearch`
and the rest are Codex's own host/IDE surface — proxying them would *bypass the
mirror*, the exact opposite of this project's point. A diplomat-bridge relays the
conversation, not the other court's furniture.

## Foundation — active turn id (LANDED)

Both `turn/interrupt` and `turn/steer` take a `turnId` precondition, and a
continuation's new turn gets a fresh one. So the run record now tracks it:

- `RunRecord.turnId` (`model.ts`) — the active turn's Codex UUIDv7.
- Set from the `turn/start` reply in `ThreadRuns.start` (`thread-run.ts`), so a
  cancel/steer arriving before the first notification already has it.
- Refreshed by the pump on every `turn/started` (`pump.ts` `apply`), so it stays
  correct across continuation turns.

`diagnostics` surfaces it per run, so the plumbing is observable before the tools
that consume it exist.

## The three lifecycle tools (LANDED)

All three are built in `ThreadRuns` (`cancel` / `steer` / `continueRun`), exposed as
MCP tools in `mcp.ts`, and tested in `test/lifecycle.test.ts`. The designs below
describe what shipped.

### `codex_cancel(handle)` → `turn/interrupt`

Mirrors Claude's Esc. Smallest of the three: the conn is alive mid-run, the record
holds `handle` (thread id) + `turnId`, so it is a direct
`turn/interrupt({ threadId, turnId })`. Fold the resulting `turn/completed`/aborted
status through the pump as usual. Edge: no active turn (already settled) → a clear
"nothing running" result, not an error.

### `codex_steer(handle, text)` → `turn/steer`

Mirrors Claude Code's steer-while-running (a message typed while the agent works):
inject guidance into the *current* turn without interrupting it.
`turn/steer({ threadId, input, expectedTurnId })` — `expectedTurnId` is the required
precondition, which is exactly why the `turnId` foundation came first. If the turn
has already moved on (precondition fails), surface that rather than silently
dropping the nudge. Also needs the app-server kept alive for the run's life (it is,
until terminal) — no disposal change required, since steering only applies to an
in-flight turn.

### `codex_continue(handle, prompt)` → `thread/resume` + `turn/start`

The highest-leverage tool and the most on-ethos. Today the thread is disposed on
`done`; continuation brings it back. Two viable mechanisms:

1. **Resume-by-thread-id (preferred).** `thread/resume({ threadId })` loads the
   persisted thread from disk — Codex keeps the rollout — and *takes fresh
   `approvalPolicy` / `permissions` / `sandbox` / `cwd` / `runtimeWorkspaceRoots`
   overrides*. So a continuation **re-runs the mirror against Claude's current live
   settings** and resumes under them, then `turn/start` with the new prompt. This is
   literally the config-compiler pattern applied per continuation — per-run spawn,
   extended to per-continuation spawn — and it means no long-lived process to keep
   warm. The record already survives past terminal (only the connection is
   disposed), so `handle` stays valid to resume against.
2. Keep the app-server alive past `done` and `turn/start` again on the same conn.
   Simpler wire-wise but abandons the re-mirror, holds a process open, and drifts
   from the per-run-spawn design. Rejected unless resume proves unreliable.

Mechanism (1) is the plan. The one real change it forces: `codex_continue`
re-provisions (fresh settings read → `mirror` → isolated `CODEX_HOME`) and calls
`thread/resume` before `turn/start`, reusing `ThreadRuns.start`'s existing
compile→provision seam. The disposal-on-terminal behaviour stays; we resume from
disk, we don't keep the process.

## Native messaging & steering — the boundary

Worth stating plainly, because it shapes what `codex_steer` can and can't be.
Claude Code's agent messaging (`SendMessage` / `ListAgents`) addresses nodes in the
harness's **agent roster**: subagents spawned via the Agent tool, teammates, other
local sessions. An MCP server is **not** a roster member — there is no MCP-side API
to advertise the server (or a background Codex run inside it) as a `SendMessage`
target. So Dragoman cannot make a Codex run a first-class message endpoint without
extending Claude Code itself. That instinct was right.

But the capability is *already there one layer up*: the `dragoman:codex-agent`
subagent **is** a real roster member. The clean routing is therefore:

```
user / Claude  --SendMessage-->  codex-agent subagent  --codex_steer-->  turn/steer
```

`codex_steer` is the primitive; the codex-agent subagent — which already drives the
run and follows its heartbeat — is the natural consumer that turns an inbound
message into a steer call. So "hook into Claude's messaging for steering" is
achievable **without** extending Claude Code, provided the subagent relays inbound
messages. That relay behaviour belongs in the `codex-agent` agent definition, not in
the server.

**Measured, not guessed (probe run 2026-08-30).** A parent → in-process-subagent
message arrives as plain prose, no structured envelope:

```
The coordinator sent a message while you were working:
<the parent's message, verbatim>

Address this before completing your current task.
```

No XML wrapper, no `from` attribute, no metadata — unlike the cross-*session* form
the SendMessage schema documents (`<cross-session-message from="…">`). Two design
conclusions follow:

1. **No parser.** The relay is an LLM subagent that already *comprehends* this prose;
   regex-matching the harness's prefix/suffix would be brittle (it's version-dependent
   wording, not a contract). The agent reads the intent and calls
   `codex_steer` / `codex_cancel` itself. The probe confirmed the format is prose, not
   machine-structured — which is exactly why comprehension beats parsing here.
2. **Latency is bounded and fine.** Delivery lands at the subagent's next tool round —
   for codex-agent, when its current `codex_status` long-poll returns (≤~100s). Good
   enough for steering; documented in the agent definition.

Outbound (codex-agent → parent) uses `SendMessage({ to: "main" })`; a subagent's send
goes out under the parent session and replies land in the parent conversation.

### Substrate: one event log (LANDED)

The recurring "we dropped that message too" problem was a symptom, not four bugs. The
fix is structural: a run keeps **one append-only timeline** (`RunRecord.events`), and
*every* inbound source — the notification loop, the approval handler, the terminal
outcome, and any future back-channel — calls the single `ThreadRuns.append`.
`codex_status` drains that one log in order. `status` stays as a separate persistent
*control* scalar (the O(1) "done?" the long-poll needs); the message *content* lives
only in the log. The old `pendingBeats` / `latestBeat` / `result` / `error` quartet —
one drained array plus three special-cased fields — collapsed into it (`model.ts`,
`thread-run.ts`, `pump.ts`, the `codex_status` renderer). Result: a new source can no
longer reintroduce the drop-bug, because there is exactly one keep-state mechanism and
adding a source is one `append` call, not a new field to remember not to clobber. This
also fixed a latent loss — progress beats that arrived in the same poll as completion
were previously drained-and-discarded on the `done` path; now they ride the same log.

### The back-channel — route by audience, not by convenience

An early instinct was to surface a "Codex message back" through the elicitation
channel, "the same way as approvals". That is wrong for the general case: **elicitation
surfaces to the human user**, not to the parent Claude session or to the codex-agent.
Routing an agent-directed message through it would pop a native prompt in front of the
wrong audience. So the back-channel splits by *who the message is for*:

| Direction | Mechanism | Audience |
|---|---|---|
| user / parent → agent | framed prose (measured above) → agent calls `codex_steer`/`codex_cancel` | the agent |
| Codex → agent | heartbeat beats drained by `codex_status` | the agent |
| agent → parent | `SendMessage({ to: "main" })` | the parent conversation |
| Codex → human (a genuine question) | elicitation | the user |

Only the last case is elicitation's job — Codex asking the *human* something, exactly
like an approval. For Codex to send the *driving agent* an in-flight note, the existing
`codex_status` heartbeat is already the channel: Codex's `agentMessage` items flow
through the pump as notifications. **LANDED** on the unified event log as one
`append` — a mid-run `agentMessage` item/completed becomes a `message` event
(`pump.ts` `agentMessageOf`), so Codex's own words reach the driving agent on its next
poll. The final message still rides `turn/completed` as the `result`; a just-streamed
final message is upgraded in place rather than delivered twice (the dedupe in
`apply`). No new channel, nothing misrouted to the user, and — because of the substrate
above — no risk of it clobbering another source's message. Covered by the back-channel
tests in `test/pump.test.ts`.

(Elicitation is not a second channel here: it is server→human question-asking, not a
way for Claude to push a message *into* a run.)

If first-class run-as-endpoint messaging is ever wanted, that is an **upstream**
conversation with Claude Code — an MCP server registering a roster-addressable
agent — not a local workaround. Noted as the durable path, not pursued now.

## Secondary tools

### `codex_review` → `review/start` — LANDED

Codex's *first-class* review pass over a `ReviewTarget` (`uncommittedChanges` |
`baseBranch` | `commit` | `custom`). Prototyped live before building (a temp repo with a
planted off-by-one), which settled two things:

- **The output is a convention, not a schema.** There is no review-finding type in the
  protocol; a review runs a review-mode turn (`enteredReviewMode` → git → `exitedReviewMode`
  → final `agentMessage`) and returns **prioritized, file:line-anchored markdown**:
  `- [P1] <title> — <file>:<lines>` bullets with an explanation. "Structured" in the
  sense of a consistent priority + location convention, parseable if we ever want inline
  comments — not JSON.
- **It earns its keep over a freeform prompt.** Structural target selection (no "review
  the uncommitted changes" prompting — it computes the diff itself), a tuned review
  harness, and the consistent `[Pn]`/location convention all come for free. It
  *prioritizes* rather than exhaustively enumerates (found the P1, ranked over a minor
  issue) — the right shape for a review.

Built as a thin sibling of `codex_run`: `ThreadRuns.review` = provision + mirror +
`thread/start` + `review/start` (via `kickReview`), returning a handle you poll with
`codex_status`; findings surface as the run's `result`. Delivery is **inline** (not
detached): per-run spawn already gives the review its own fresh thread, so there's
nothing to keep it off, and inline keeps notifications on our handle where the pump
routes them. Tool params: `cwd` (required), `against` (base ref → `baseBranch`),
`instructions` (→ `custom`), else `uncommittedChanges`. Covered in `test/lifecycle.test.ts`.

### `codex_diff` → `gitDiffToRemote` — DROPPED

`gitDiffToRemote({ cwd })` returns `{ sha, diff }`. Dropped: the driving agent (Claude)
would just run `git diff` itself — it has shell access and the cwd — so a dedicated tool
adds a round-trip and an app-server dependency for something already trivially at hand.
No real reach here, unlike a review. (Kept in the record so the call isn't relitigated.)

## Diagnostics — production observability (LANDED)

`diagnostics` was marked TEMPORARY ("remove once mirroring is settled"). It is kept
and promoted to the permanent operator view — it only grows more useful as the tool
surface does. Changes made:

- Header reframed from throwaway probe to permanent observability tool.
- New **Active runs** section: every live/recently-settled run with `status`,
  active `turnId`, and latest milestone — the operational half the env/mirror
  sections can't show ("is anything stuck / waiting / unaccounted for right now").
- Reports the Dragoman version; takes the run registry (`diagnostics(runs)`).
- Unchanged safety: settings-file *presence* and permission/sandbox *keys* only,
  never file contents.

## Sequencing

1. **Foundation — `turnId`.** DONE.
2. **Diagnostics production-ization.** DONE.
3. **`codex_cancel`** — smallest, exercises `turnId` end-to-end, no disposal change. DONE.
4. **`codex_steer`** — same precondition, adds the in-flight-turn injection path. DONE.
5. **`codex_continue`** — the structural one (resume + re-mirror). DONE.
6. **Unified event log + `agentMessage` back-channel.** DONE.
7. **`codex-agent` relay** — the agent-definition guidance is written (turn an inbound
   message into `codex_steer`/`codex_cancel`, relay Codex's own `message` events back).
   OPEN: verify end-to-end in a live run that a mid-run `SendMessage` actually reaches
   the subagent between polls — no code expected, just the empirical check.
8. **Secondary — `codex_review`.** DONE (prototyped, then built as a thin `codex_run`
   sibling). `codex_diff` dropped (Claude runs `git diff` itself).

The landed tools sit behind the existing `FakeAppServer` unit seam
(`test/lifecycle.test.ts`, `test/pump.test.ts`); a ratcheted live integration test for
the resume + re-mirror path is the natural next verification step, matching how
`codex_run` is locked.
