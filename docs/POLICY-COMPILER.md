# Policy compiler — design

_How Claude's merged settings become a Codex run's policy. The umbrella
architecture the per-axis mapping docs (e.g._ [`FILESYSTEM-MAPPING.md`](FILESYSTEM-MAPPING.md)_) plug into._

Status: **design** — supersedes the current static-profile mapping. Falsifies the
"profiles must be pre-baked" constraint (see [Why the old shape was an artifact](#why-the-old-shape-was-an-artifact)).

## The principle

Dragoman is a **config compiler**: it reads one config model (Claude's) and
produces another (Codex's), fully dynamically, per run. There are **no static
profile templates** — every knob Codex receives is *derived* from what Claude's
config actually says, right now, for this run.

Three stages, strictly separated:

```
  Compose            Compile                     Provision
  (merge, IO)   →    (pure, in-memory)     →     (IO: disk + process)
  layered      →    composite settings    →     write config.toml,
  settings          → full CodexPolicy          spawn app-server,
                                                 run the turn
```

The separation is the design. **Compile never touches the filesystem or a
process; provision never computes policy.** That line is what makes the compiler
trivially testable and the lifecycle swappable.

## Stage 1 — Compose (exists)

`readSettings()` → `mergeSettings(layers)` → **one composite `EffectiveSettings`**.
Claude's four layers (user, user-local, project, project-local) are merged by
Claude's own rules: permission/sandbox **arrays union** across layers, **scalars
last-wins** by precedence. This is the single composite object graph the compiler
reads from — with **random access**, not a strict walk (a single Claude setting
may fan out to several Codex knobs, and several Claude settings may fold into one).

This stage already exists and is unit-tested against fixture trees with no IO.

## Stage 2 — Compile (pure, in-memory)

```ts
compile(composite: EffectiveSettings, mode: ClaudeMode): CodexPolicy
```

A **pure, total function**. Input: the composite (+ the resolved Claude mode).
Output: a complete in-memory `CodexPolicy` — everything Codex needs for this run:

- the **config-file model**: the managed `[permissions]` profile(s) — scope
  (`extends`), `filesystem` table, `network` rules — and `default_permissions`;
- the **per-turn params**: `approvalPolicy`, `approvalsReviewer`,
  `runtimeWorkspaceRoots`, and which profile id (or inline `sandboxPolicy`) the
  thread selects.

Rules for this stage, non-negotiable:

- **No filesystem. No process. No network. No clock.** Pure data in, pure data
  out. If it needs to know something, it comes from the composite.
- **No premature optimization.** It processes the *whole* composite and splurges
  out the *whole* policy every time. Recomputing is fine. It must **not**
  special-case "this fits an inline `sandboxPolicy` so skip the profile" or any
  such shortcut — that's an emit-time concern, not a compile-time one.
- **No static templates.** No fixed pair of profiles, no `mode → base` lookup
  table. Scope is *derived* (below). The output is whatever the composite implies.

### Per-axis mappers

`compile` is a composition of small pure functions, one per axis — each its own
piece, its own doc, its own tests:

| Axis | Claude source | Codex target | Doc |
|---|---|---|---|
| **Scope** | `sandbox.enabled` (+ plan intent) | profile `extends` / `sandboxPolicy` type | this doc |
| **Filesystem** | `sandbox.filesystem.{allow,deny}{Read,Write}` | profile `[…].filesystem` table | [`FILESYSTEM-MAPPING.md`](FILESYSTEM-MAPPING.md) |
| **Network** | `sandbox.network.*` + `WebFetch(domain:)` rules | profile `[…].network` | _(to write)_ |
| **Approval** | permission `mode` | `approvalPolicy` + `approvalsReviewer` | _(to write — pending steer)_ |
| **Exec rules** | `Bash(...)` allow/deny rules | execpolicy amendments + pre-declines | _(exists in `mirror.ts`)_ |

### Scope is derived, not looked up (the core correction)

Claude's **permission mode** and Claude's **OS sandbox** are orthogonal axes. The
old code conflated them (`baseFor(mode)`). They separate cleanly:

- **Sandbox config → OS scope.**
  - `sandbox.enabled` falsy (the common local case) → Claude imposes no OS
    sandbox, so Codex gets **`dangerFullAccess`** (write anywhere, open network).
    Mirroring more restrictively than Claude is the one direction we never go.
  - `sandbox.enabled` true → scope `:workspace`, and the `filesystem` / `network`
    tables mirror `sandbox.filesystem` / `sandbox.network` precisely.
  - `plan` is a read-only *intent* → `:read-only` regardless of sandbox config.
- **Mode → approval only.** `mode` picks `approvalPolicy` (+ `approvalsReviewer`);
  it never picks the OS scope.

### Network: hints are not a fence

`WebFetch(domain:…)` allow rules are Claude **auto-approve hints**, not a global
restriction — under no sandbox, Claude's own tools reach any host. So domains form
a closed allowlist **only when Claude is actually sandboxing**. Unsandboxed →
network open, no allowlist synthesized from hints.

## Stage 3 — Provision (IO: disk + process)

```ts
provision(policy: CodexPolicy): Promise<AppServer>
```

Takes the in-memory policy and does the side effects the compiler refused to:

1. **Serialize** the config-file model to `config.toml` in an isolated
   `CODEX_HOME` (auth symlinked from the real `~/.codex`, never touched).
2. **Spawn** a `codex app-server` against that `CODEX_HOME`.
3. **Wire** the pump / notification reader onto the connection and run the turn
   with the policy's per-turn params.

All filesystem and process lifecycle live **only here**. The existing
`ensureCodexHome` + `codex-config.ts` renderer become provision's serializer.

### Lifecycle: per-run spawn

Because the app-server reads `config.toml` at **its** spawn, and *we* own when we
spawn it, config is as dynamic as we want. **Each `codex_run` spawns its own
app-server** from the current composite — full isolation, no cache invalidation,
no cross-run staleness, no race at human timescales. The pump / single
notification-reader is **per app-server** (as the integration harness already
does), so per-run spawn means per-run pump.

Spawn cost is a one-time process start against a peer run measured in minutes —
negligible. (Worth a cold-start measurement before locking it in, but not a
blocker.)

## Caching is a decorator, added later (Open/Closed)

Per-run spawn is the core. Caching (reuse an app-server while the composite is
unchanged) is bolted on **from the outside, never by editing the core**:

```ts
// core, unchanged:
provision(policy)                     // always spawns

// later, decorate:
const cachedProvision = withConfigHashCache(provision)
```

Because `compile` and `provision` are clean single-purpose functions, a cache is a
decorator keyed by the policy's hash — reuse on hit, delegate to the real
`provision` on miss/change. The core implementation stays a straight
"always spawn." No caching logic leaks inward.

## Why the old shape was an artifact

Not a Codex constraint — a consequence of one design choice:

- `ThreadRuns.connection()` **memoizes a single app-server**, spawned lazily on
  the first `codex_run` and reused forever.
- `main.ts` generates `config.toml` **once**, from a single `readSettings()` at
  that first spawn (`ensureCodexHome(allProfiles(readSettings()))`).

So settings were frozen at first run, and two profiles were pre-baked because a
reused server can't be reconfigured. Per-run spawn dissolves both: fresh process,
fresh config, computed from live settings every time.

**Removed by this design:** `PROFILE_BASES`, `baseFor`, the fixed `allProfiles`
pair, the memoized single connection, and config-frozen-at-first-spawn.

## Why this shape

Prior art: this is the standard **config-compiler** shape — normalize the source
into one model, transform purely to the target model, emit through a swappable
backend. Terraform providers (HCL → cloud API), OPA/Rego (policy → decision),
nftables generators, Babel (AST → AST) all wear it. We borrow the *pattern*, not a
framework — two known schemas and a small transform.

**Testing falls out of the separation.** `compile` is pure and in-memory:
example-based tests per axis plus a property test — *any* composite produces a
valid Codex policy that is **never more restrictive than Claude**. `provision` is
the thin IO seam, covered by the live integration ratchet that already proves
Codex honours the emitted config.

## Open

- **Approval axis mapping** — `mode → approvalPolicy + approvalsReviewer`. `auto`'s
  reviewer is the live design question. Note: routing approvals to *Claude's* model
  is not available (Claude Code advertises no MCP `sampling`; elicitation is
  human-only — see the recorded finding), so the choice is Codex-side
  (`auto_review` / `guardian_subagent`) vs the human elicitation seam.
- **`CodexPolicy` type** — the exact in-memory shape (config-file model + per-turn
  params) the two stages hand across.
- **Cold-start measurement** — confirm per-run spawn latency is acceptable before
  deferring caching.
