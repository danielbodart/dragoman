# Plan: the full peer-agent lifecycle

_Status: the foundation, the production `diagnostics` probe, and all three
lifecycle tools (`codex_cancel`, `codex_steer`, `codex_continue`) have landed —
wired into the MCP surface and covered by `test/lifecycle.test.ts`. Still open: the
`codex-agent` messaging relay, and the two secondary reporting tools
(`codex_review`, `codex_diff`)._

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
through the pump as notifications. On the unified event log this is now literally **one
`append`** — surface a **mid-run** `agentMessage` as a `progress` (or `message`) event;
today only the final one becomes the terminal `result` event, so intermediate
commentary Codex emits is dropped. No new channel, nothing misrouted to the user, and —
because of the substrate above — no risk of it clobbering another source's message.

(Elicitation is not a second channel here: it is server→human question-asking, not a
way for Claude to push a message *into* a run.)

If first-class run-as-endpoint messaging is ever wanted, that is an **upstream**
conversation with Claude Code — an MCP server registering a roster-addressable
agent — not a local workaround. Noted as the durable path, not pursued now.

## Secondary tools

### `codex_review(handle-or-target)` → `review/start`

Codex's *first-class* review mode: structured findings against a `ReviewTarget`
(`uncommittedChanges` | `baseBranch` | `commit` | `custom`), delivered inline or on
a detached thread. The `codex-agent` already "reviews" via a freeform prompt; this
yields structured output instead. It is a specialization, not a lifecycle gap — it
could ship as a `codex_run` posture/target variant rather than a standalone tool.
Lower priority than the lifecycle three.

### `codex_diff(handle)` → `gitDiffToRemote`

`gitDiffToRemote({ cwd })` returns `{ sha, diff }` — the exact change Codex
produced. Lets the agent report *precisely* what changed on hand-back instead of
narrating it from memory. Small, purely additive reporting polish; pairs naturally
with the `codex-agent`'s result summary.

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
6. **`codex-agent` relay** — teach the subagent to turn inbound `SendMessage` into
   `codex_steer` (agent-definition change, no server change). OPEN.
7. **Secondary** — `codex_review`, `codex_diff`, as appetite allows. OPEN.

The landed tools sit behind the existing `FakeAppServer` unit seam
(`test/lifecycle.test.ts`); a ratcheted live integration test for the resume +
re-mirror path is the natural next verification step, matching how `codex_run` is
locked.
