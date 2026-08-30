# Design

_Mirror Claude, don't reinvent it._

Dragoman is a **config compiler**, not a policy of its own. It reads Claude Code's
own merged settings and compiles them into a Codex run's policy, per turn. It only
asks a question when Claude's policy can't answer — and when it does, it uses
Claude's native approval prompt. Nothing is static: every Codex knob is derived
from Claude's live config, the way Terraform derives a plan or Babel derives output
from its input.

The per-setting result of all this is [`MAPPING.md`](MAPPING.md); this doc is the
machine that produces it.

## Two orthogonal axes

The correction that shaped the codebase: Claude has two **independent** axes, and
the old design conflated them.

- **Permission mode → prompting.** Whether Claude asks before an action, for both
  tool calls and bash → Codex's `approvalPolicy` + reviewer, plus allow/deny rules
  as execpolicy.
- **Sandbox → OS confinement of bash only.** Claude's sandbox confines the terminal
  space; it never touches tool calls → Codex's sandbox scope + filesystem/network
  tables.

So `sandbox-off` is **not** `danger-full-access`: danger means *no confinement AND
no prompting*; sandbox-off while still asking is unconfined bash that prompts every
time.

## Pipeline: compose → compile → provision

Three strictly-separated stages — compile never touches disk or a process, provision
never computes policy.

1. **Compose** (IO) — read Claude's four settings layers (user, user-local, project,
   project-local) and merge by Claude's own rules: permission/sandbox **arrays
   union**, **scalars last-wins**, into one `EffectiveSettings`.
2. **Compile** (pure) — `mirror` turns settings + mode into a `CodexPolicy`: the
   managed `[permissions]` profiles (scope `extends`, `filesystem`, `network`) plus
   per-turn params (`approvalPolicy`, `approvalsReviewer`, `runtimeWorkspaceRoots`,
   plan mode). No filesystem, process, or clock.
3. **Provision** (IO) — serialize to `config.toml` in an isolated `CODEX_HOME`,
   spawn `codex app-server`, wire the pump.

## Isolated `CODEX_HOME`

Dragoman runs Codex against its own home: auth symlinked from `~/.codex`, config =
the user's config **plus** a managed profile block and execpolicy rules. Mirroring
is fully contained — it never touches the real `~/.codex`. The managed permission
profile is the single sandbox path (scope + filesystem + network as one renderer).

## Per-run spawn — isolated config, shared state

Every `codex_run` provisions its **own** app-server from the settings read at that
moment — the live mode is always current. But the isolation is deliberately **narrow**:
only what must be per-run is isolated — `config.toml` (the managed profile + the global
`network_proxy` flag) and `rules/` (Claude's live allow/deny as execpolicy, discovered
globally per home). Both are filesystem-level and differ per run, which is the whole
reason the home is per-run.

Everything durable is **shared**, split by what it is. The thread rollout (`sessions/` +
`session_index.jsonl`) is symlinked in from a Dragoman-owned store (`~/.dragoman/shared`),
so it survives the home's teardown and `codex_continue` can `thread/resume` it later —
without sharing, a fresh home gives `-32600: no rollout found`. It's kept in Dragoman's
own store, NOT the real `~/.codex`, so Dragoman never writes history into the user's
codex or pollutes their `codex resume` list. Caches (`cache/` + `models_cache.json`), by
contrast, symlink to the REAL home — pure perf, regenerable, so a run starts on the
user's already-warm model cache; performance wins over containment there. (`auth.json`
already makes the same move to the real home. The volatile sqlite state and locks stay
per-run — sharing them across concurrent processes would risk corruption, and resume
rebuilds from the rollout without them.) Caching is a later decorator over `provision`,
never edited into the core.

## Async approval bridge

A blocking approval would hit Claude Code's ~120 s tool-call ceiling, so Dragoman
fires the elicitation and returns, delivering the decision out of band. This is the
core fix for the official plugin's hang (it rejected Codex's approval requests with
`-32601`, leaving `danger-full-access` as the only workaround). Allow-rules
auto-accept and deny-rules pre-decline in-process; the rest elicit natively.

## Live mode sourcing

`permissions.defaultMode` is only the *static* mode; the live mid-session mode is
session state the MCP server can't read (diagnostics once showed `defaultMode=auto`
while the session was in manual). A **PreToolUse hook**
(`packaging/inject-posture.sh`, matched narrowly on `codex_run`) reads Claude's
`.permission_mode` off stdin and injects it as `posture`. Resolution order:
explicit `posture` ?? hook-injected live mode ?? static `defaultMode` ?? safe
default. (A PreToolUse `updatedInput` *replaces* the tool input, so the hook echoes
the whole input back with `posture` added.)

## Verification

A **testable seam** (an `AppServerConn` interface + a `FakeAppServer`) keeps the
unit tests pure; live behaviour is locked by **ratcheted** integration tests — each
runs once until green, records a marker, then is skipped (and skipped entirely on
machines without `codex`). Per-setting evidence lives in [`MAPPING.md`](MAPPING.md).
