---
name: codex
description: Hand a task to OpenAI Codex — runs as a background peer agent (second implementation, review, or investigation).
argument-hint: [what Codex should do]
---

Hand the following task to **OpenAI Codex** by spawning the `codex` subagent (it
drives the Dragoman bridge: starts the run, follows the heartbeat, relays approvals,
and reports Codex's result as Codex's own).

**Task for Codex:**

$ARGUMENTS

Spawn the `codex` subagent now with that task. Give it:
- the **absolute `cwd`** for the work (default to the current working directory
  unless the task names another),
- the **posture** matching how you're currently operating (use `plan` if this is a
  review or investigation that must not touch files; otherwise your active
  permission mode),
- and enough context from the task above that Codex — which starts cold, with none
  of this conversation — has a self-contained brief.

If the task is empty, ask what Codex should do before dispatching.
