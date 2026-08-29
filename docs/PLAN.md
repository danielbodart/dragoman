# Dragoman — Plan

_The interpreter between two courts: a local bridge making OpenAI **Codex** a
native-feeling subagent inside Anthropic's **Claude Code**._

## Problem

The official Codex plugin drives Codex like a batch job: **approvals hang** (it
rejects Codex's server→client requests with `-32601`, so the only workaround is
`danger-full-access`), and **progress is invisible** (a single final blob).
Dragoman is greenfield, built on Codex's supported **app-server** (the
`mcp-server` is deprecated), translating Codex's approvals, progress and
permissions onto Claude Code's own mechanisms.

## Architecture (verified against codex-cli 0.150.1 / claude-code 2.1.250)

- **One thin bridge per Claude session** → the shared singleton Codex app-server;
  each `codex_run` is a thread. Codex is spawned lazily (`codex app-server` stdio,
  NDJSON-framed) and connected on first use.
- **Isolated `CODEX_HOME`.** Dragoman spawns codex against its own home — auth
  symlinked from `~/.codex`, config = the user's config **plus a managed profile
  block** — so mirroring never touches the user's real `~/.codex`. No leak.
- **The mirror is two axes.** The **permission profile** (in the isolated config)
  is the unified sandbox/isolation axis — scope + filesystem + network; **`approvalPolicy`
  plus the pump's allow/deny/elicit** is the "when to ask" axis. Writable roots
  ride `runtimeWorkspaceRoots` (a thread param). `bypassPermissions` is the one
  non-profile posture (→ the `danger-full-access` sandbox enum).
- **Approvals fire async.** A blocking tool call hits Claude Code's ~120s ceiling,
  so Dragoman fires the elicitation and returns, delivering the decision
  out-of-band. Allow-rules auto-accept and deny-rules pre-decline in-process; the
  rest elicit natively.
- **Progress is a sparse heartbeat**, surfaced by **long-polling** `codex_status`
  (event-driven, capped under the tool-call ceiling), not a firehose.
- **Testable seam** — an `AppServerConn` interface + `FakeAppServer` for unit
  tests; live behaviour locked by ratcheted integration tests.

## Landed

- Async approval bridge (native elicitation) — the core hang fix.
- Settings mirror → **permission profile**: mode→approval, scope (read-only /
  workspace / danger), network (coarse on/off **and** per-host allow/deny via
  Codex's network proxy), `additionalDirectories` → `runtimeWorkspaceRoots`.
- Execpolicy: Claude `allow` Bash rules auto-accept; `deny` Bash rules pre-decline
  (fail-closed, catches wrapped/chained/env-prefixed commands).
- Network mirrors Claude's *real* posture (on unless Claude is actively
  sandboxing; `WebFetch(domain:)` allows merged in).
- **Isolated `CODEX_HOME`** — mirroring is fully contained; the profile is the only
  sandbox path (legacy sandbox enum/policy removed).
- Sparse heartbeat + long-poll `codex_status`.
- Single self-contained binary (Bun), mise tasks, **trunk-based CI release**,
  Apache-2.0 licence.
- Clean process lifecycle — exits on signal / stdin-close (no stray processes).
- Empirical verification — unit + ratcheted live integration tests; per-mapping
  evidence in [`MIRROR-VERIFICATION.md`](MIRROR-VERIFICATION.md).
- **Native integration** — a Claude Code **`/dragoman:codex` skill** (usage
  guidance, so Claude reaches for Codex naturally) and a **`dragoman:codex-agent`
  subagent** (drives the run with the right posture and narrates the heartbeat in
  its own voice).
- **Packaged as a Claude Code plugin** — installable via
  `/plugin marketplace add danielbodart/dragoman` + `/plugin install`. The plugin
  archive bundles all four platform binaries (darwin/linux × arm64/x64); a
  committed POSIX **launcher** selects the right one at runtime — no Bun/Node, no
  build step, no first-run download. CI builds the archive and repoints
  `marketplace.json` (pinned url+sha256) on every trunk release; the pointer commit
  is `paths-ignore`d so it never loops.

## Remaining

- **Fine-grained filesystem mapping** — `sandbox.filesystem.allowRead/denyRead/
  allowWrite/denyWrite` → profile `file_system` entries. The `file_system` key
  loads; the read/deny **access** semantics still need working out (writable roots
  already covered by `runtimeWorkspaceRoots`). Uncommon; deferred.
- **Model-answered approvals (v2).** Route approvals to Claude's *model* via a
  tool-call channel (`codex_answer`) — the one MCP channel the model participates
  in — instead of only the human. Designed; not built.

## Open

- Icon (the crossed scrolls / compass mark).

---

_Design and mappings verified against `codex-cli 0.150.1` and `claude-code 2.1.250`;
per-mapping evidence lives in [`docs/MIRROR-VERIFICATION.md`](MIRROR-VERIFICATION.md)._
