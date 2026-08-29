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
languages do business. That is this tool's job: Claude Code and the Codex
app-server speak different protocols, and Dragoman translates between them — so
Codex's approvals, progress, and permissions feel like they were built into Claude
all along.

## Why

The official Codex plugin drives Codex well but interfaces with Claude like a batch
job:

- **Approvals don't work.** When Codex asks "may I run this command?", the plugin
  rejects the request, so it hangs — unless you disable the sandbox entirely.
- **Progress is invisible.** Claude sees one final blob, not what Codex is doing.
- **Permissions and mode aren't mapped** — let alone fine-grained sandbox rules.

Dragoman fixes all three by talking to the Codex **app-server** — the supported,
actively-developed interface — and mapping its approval, mode, permission and
progress flows onto Claude Code's own native mechanisms.

## Mirror Claude, don't reinvent it

Dragoman reads Claude Code's own settings and mirrors them onto Codex per run, so
Codex inherits Claude's posture with **no config of its own**. It only asks you a
question when Claude's policy can't answer — and when it does, it uses Claude's
native approval prompt.

| Claude Code | → Codex | Status |
|---|---|---|
| Permission mode (`plan` / `default` / `auto` / `bypass`…) | approval policy + profile scope | ✅ |
| Sandbox scope (read-only / workspace-write / danger) | permission-profile base | ✅ |
| `permissions.additionalDirectories` | `runtimeWorkspaceRoots` (writable roots) | ✅ |
| Network on/off (mirrors Claude's real posture) | profile `network.enabled` | ✅ |
| `sandbox.network.allowedDomains` / `deniedDomains` / `WebFetch(domain:)` | per-host allow/deny via Codex's network proxy | ✅ |
| `permissions.allow` Bash rules | auto-accept (execpolicy amendment) | ✅ |
| `permissions.deny` Bash rules | pre-decline (fail-closed) | ✅ |
| Approvals for anything uncovered | **async native elicitation** | ✅ |
| Codex progress | **sparse heartbeat**, surfaced on poll | ✅ |
| `sandbox.filesystem.allowRead` / `denyRead` / `denyWrite` | profile `file_system` entries | ⏳ planned |

Mirroring runs against an **isolated `CODEX_HOME`** (auth inherited from `~/.codex`,
config = your config + a managed profile block), so it never touches your real
Codex config.

## Status

**Working.** The mappings above are implemented and verified — unit-tested and
locked by live integration tests against real Codex. Still to come: packaging as a
Claude Code plugin, a skill/subagent so it feels fully native, and the fine-grained
filesystem rules. See [`docs/PLAN.md`](docs/PLAN.md).

## Install

Build the single binary and register it as an MCP server:

```bash
mise run build
claude mcp add dragoman -s user -- "$PWD/dist/dragoman" serve
```

Codex must be on your `PATH` (Dragoman spawns `codex app-server`).

## License

Copyright 2026 Daniel Bodart. Licensed under the [Apache License 2.0](LICENSE).
