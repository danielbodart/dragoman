<p align="center">
  <img src="docs/logo.png" alt="Dragoman" width="360">
</p>

<h1 align="center">Dragoman</h1>

<p align="center">
  <em>The interpreter between two courts.</em><br>
  A local bridge that makes OpenAI <strong>Codex</strong> a native-feeling subagent inside Anthropic's <strong>Claude Code</strong>.
</p>

---

A _dragoman_ was the interpreter-diplomat who let two courts speaking different
languages do business. That is exactly this tool's job: Claude Code and the Codex
app-server speak different protocols, and Dragoman translates between them — so
Codex's approvals, progress, and permissions feel like they were built into Claude
all along.

## Why

The official Codex plugin drives Codex well but interfaces with Claude like a batch
job. Two things make it feel primitive:

- **Approvals don't work.** When Codex asks "may I run this command?", the plugin
  rejects the request outright, so it hangs — unless you disable the sandbox
  entirely (`danger-full-access`).
- **Progress is invisible.** Claude sees one final blob, not what Codex is doing.

Dragoman fixes both by talking to the Codex **app-server** — the one supported,
actively-developed interface (`codex mcp-server` is
[deprecated](https://github.com/openai/codex/issues/11816)) — and mapping its
approval and progress flows onto Claude Code's own native mechanisms.

## The idea in one line

**Mirror Claude, don't reinvent it.** Dragoman reads Claude Code's own settings
(sandbox scope, approval mode, permissions) and mirrors them onto Codex per turn.
It only asks you a question when Claude's own policy can't answer — and when it
does, it uses Claude's native approval prompt.

## Status

🚧 **Early design.** See [`docs/PLAN.md`](docs/PLAN.md) for the architecture and
the build roadmap. Nothing is shippable yet; this is the first commit.

## Design at a glance

| Concern | Approach |
|---|---|
| Runtime | Bun, compiled to a **single binary** (no Bun dependency for users) |
| Topology | One thin bridge **per Claude session** → the **shared singleton** Codex daemon |
| Isolation | **Per-thread** inside the one daemon (Codex's own model), configured per project |
| Approvals | Codex approval → async MCP **elicitation** → Claude's native allow/deny prompt |
| Config | **Mirror Claude Code's settings** onto each turn; no separate config file |
| Progress | A **filter, not a pipe** — collapse Codex's event stream to a sparse heartbeat |

## License

TBD.
