---
name: codex
description: >-
  Hand a coding task to OpenAI Codex from inside Claude Code — a second
  implementation, an independent review or second opinion, or a deep
  root-cause investigation, run as a background peer agent. Use whenever
  the user says "ask Codex", "get Codex to…", "hand this to Codex",
  "what does Codex think", "second opinion from Codex", or wants a parallel
  or independent take on code. Covers how to start a run, follow its
  progress, answer its approvals, and pick the right permission posture.
version: 0.1.0
---

# Driving Codex through Dragoman

Codex (OpenAI's coding agent) runs as a **background peer** via the Dragoman
bridge. It starts with a fresh context — it does **not** see this conversation —
so a run is a self-contained hand-off, not a continuation of your own reasoning.
That independence is the point: use it when a genuinely separate agent adds value.

## When to reach for Codex

- **Second implementation.** You want the same task built a different way, to
  compare — or you're stuck and want a fresh attempt.
- **Independent review / second opinion.** Codex reviews a diff or design with no
  knowledge of how you arrived at it — a real outside read, not an echo.
- **Deep investigation.** A gnarly root-cause hunt worth running in parallel while
  you keep working.
- **Offload.** A well-specified, self-contained job you can delegate and collect.

Do **not** reach for Codex for trivial edits you'd finish faster yourself, or when
the task depends on unwritten context from this conversation that you won't put in
the prompt.

## The two ways to drive it

**Prefer the `codex-agent` subagent** for any substantial hand-off (spawn it via
`subagent_type: "dragoman:codex-agent"`). It runs the start→poll→narrate loop in its own context, so the
back-and-forth of following a long run never floods this conversation — you get the
result back, clean.

Use the **tools directly** for a quick one-off you want to watch inline:

1. **Start** — `codex_run({ prompt, cwd })` returns a handle immediately (omit
   `posture` — see below).
   The run proceeds in the background.
2. **Follow** — poll `codex_status({ handle })` in a loop. Each call long-polls
   (blocks until Codex advances, up to ~100s) and returns a one-line heartbeat:
   `Running — <beat>`, `Waiting for your approval — <beat>`, `Done. <result>`, or
   `Errored: <reason>`. Keep polling until `Done.` or `Errored:`. Narrate the beats
   in your own voice rather than dumping them raw.
3. **Approvals surface natively.** When Codex asks to run a command or write a file
   that your posture doesn't pre-authorize, it appears as a normal Claude Code
   approval prompt. Just answer it — Dragoman delivers your decision back to Codex
   out-of-band. (Allow/deny rules from your settings auto-answer; only the rest ask.)

## Staying in control of a run

A run isn't fire-and-forget — you can act on it the way you would your own work:

- **Steer** — `codex_steer({ handle, text })` sends guidance to a **running** task
  without stopping it (a new constraint, a correction, "focus on X, skip Y"). Codex
  keeps its context and carries on; keep polling to watch it take effect. Reach for
  this the moment Codex drifts — it beats cancelling and re-briefing.
- **Cancel** — `codex_cancel({ handle })` stops a run that's gone off the rails or is
  no longer needed. Poll `codex_status` to confirm it stopped. Prefer *steer* to
  redirect rather than abandon.
- **Continue** — after `Done.`, `codex_continue({ handle, prompt })` sends a follow-up
  on the **same thread**, so Codex keeps everything it learned instead of starting
  cold — the natural next step ("now write the tests", "also update the changelog").
  Reuse the original handle; it re-mirrors your current posture, so the same
  leave-`posture`-unset rule applies. (Still running? Steer, don't continue.)

## Writing the prompt

Codex has none of your context. Give it everything: the full task, the files and
paths involved, what "done" looks like, and any constraints. Treat it like briefing
a capable engineer who just walked in. `cwd` must be the **absolute path** to the
working directory for the task.

## Posture — leave it to Dragoman

**Normally don't pass `posture` at all.** When you omit it, Dragoman reads Claude's
*live* permission posture and mirrors it onto Codex, so Codex runs with exactly the
access you have. That auto-mirroring is the whole point — don't second-guess it by
passing a mode you *think* matches your session; you'll usually get it wrong and
leave Codex more restricted (or more permissive) than Claude actually is.

Only pass `posture` when the **user explicitly** asks Codex to run in a particular
mode. What each override means, if you do:

| posture | Codex runs… |
|---|---|
| `plan` | read-only — investigation and review, no edits |
| `default` | normal — asks before acting outside the workspace |
| `acceptEdits` | edits the workspace freely, asks for the rest |
| `auto` | acts in the workspace, asks before leaving it |
| `dontAsk` | proceeds without pausing to ask, still sandboxed |
| `bypassPermissions` | full access |

The commonest legitimate override is a user asking for a **read-only** review →
`plan`.

## After the run

Relay Codex's result as its own contribution — attribute it ("Codex found…",
"Codex's take:"), and where it's a second opinion, say where it agrees or differs
from yours. Don't silently merge its output into your own voice.
