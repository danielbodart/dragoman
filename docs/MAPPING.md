# Mapping — Claude Code settings → Codex

How each Claude Code setting is mirrored onto a Codex run. Verified against
`codex-cli 0.150.1` / `claude-code 2.1.250`; the evidence is the test suite —
unit tests prove Dragoman **emits** the right policy, ratcheted live integration
tests prove Codex **honours** it. The design behind this lives in
[`DESIGN.md`](DESIGN.md).

Claude has **two orthogonal axes**, and Dragoman keeps them separate:

- **Permission mode → _when to prompt_** — Codex `approvalPolicy` + reviewer (plus
  Codex's native plan mode), and the allow/deny Bash rules as execpolicy.
- **Sandbox → _how bash is confined_** — the Codex permission profile's scope,
  filesystem and network tables.

Everything below is carried by a **managed permission profile** in an isolated
`CODEX_HOME` (the deprecated `sandbox` enum is gone). `bypassPermissions` is the
one posture with no profile — it maps to Codex's `danger-full-access`.

## Permission mode

| Claude mode | Scope (`extends`) | `approvalPolicy` | Reviewer | Effect | |
|---|---|---|---|---|---|
| `plan` | `:read-only` | `on-request` + native plan | — | Reads run free; the model refuses writes **at the source**; no prompts. | ✅ |
| `default` / `manual` | `:read-only` | `untrusted` | `user` | Reads auto-run; **every** edit or write escalates to a native human approval. | ✅ |
| `acceptEdits` | `:workspace` | `granular` | `user` | In-workspace edits auto-run; anything escaping the workspace escalates to a human. | ✅ |
| `auto` | `:workspace` | `granular` | `auto_review` | Escapes are judged by Codex's own model reviewer. | ✅ |
| `dontAsk` | `:read-only` | `untrusted` | — | Only pre-approved (allow-rule) commands + reads run; everything else refused, never asked. | ✅ |
| `bypassPermissions` | danger-full-access | `never` | — | Everything, unconfined, no checks. | ✅ |

Manual mode's config value is `default`; the CLI also accepts `manual`. The
**live mid-session mode** (not just static `permissions.defaultMode`) is captured
by a PreToolUse posture hook — see [`DESIGN.md` → Live mode sourcing](DESIGN.md).

**Why judged modes need a sandbox:** Codex only runs its review classifier when a
sandbox wall exists — `danger-full-access` = no wall = no review. So `auto` maps
to `:workspace` + `granular`, never danger.

**Two channels, gated separately:** shell commands are gated by the sandbox
**scope**; file edits (`apply_patch`) by the **approval policy**. Under `untrusted`
*every* edit prompts even inside a writable workspace; `granular` lets in-workspace
edits auto-run and raises only escapes. That is why `acceptEdits` and `auto` use
`granular`, differing only in reviewer (human vs Codex classifier).

## Sandbox scope & writable roots

| Claude Code | → Codex | |
|---|---|---|
| Sandbox scope (read-only / workspace-write / danger) | profile `extends` base | ✅ |
| `permissions.additionalDirectories` | `runtimeWorkspaceRoots` (writable roots — they define what `:workspace_roots` is) | ✅ |

## Filesystem — the third profile axis

`sandbox.filesystem.{allow,deny}{Read,Write}` → the profile's
`[permissions.<id>.filesystem]` path→access map. ✅ built + verified live
(read-deny model-free; write-carve on one real turn).

| Claude list | Meaning | Codex access |
|---|---|---|
| `allowRead`  | may read here            | `read` |
| `allowWrite` | may write here           | `write` |
| `denyWrite`  | may read, **not** write  | `read` (downgrade, not removal) |
| `denyRead`   | may **not** even read    | `deny` |

- Fold per unique path, **deny wins**: `denyRead → deny` ▸ `denyWrite → read` ▸
  `allowWrite → write` ▸ `allowRead → read`.
- `deny` blocks reads **and** writes; `read` = read-only; `write` = read+write.
- The table **augments** the base scope (files outside it keep the base's access);
  narrower/more-specific path wins.
- Absolute paths anchor the top-level table; relative paths and globs go under the
  `:workspace_roots` sub-table so they track the session's real roots.

**Two-token gotcha (locked live):** the enforced TOML key is `filesystem` (not
`file_system`) and the deny value is `deny` (not `none`). Both wrong tokens load
silently and enforce nothing — a long probe detour, encoded here so nobody repeats
it.

## Network

| Claude Code | → Codex | |
|---|---|---|
| Network on/off (mirrors Claude's *real* posture — open unless Claude is actively sandboxing) | profile `network.enabled` | ✅ |
| `sandbox.network.allowedDomains` / `deniedDomains` | per-host allow/deny in the profile's `[…network.domains]`, enforced via Codex's network proxy; **deny wins** | ✅ |

The allowlist can come from either `sandbox.network.allowedDomains` **or**
`WebFetch(domain:)` rules (Claude merges both). Per-host filtering only enforces
with the network proxy enabled, which Dragoman sets whenever host rules exist.

## WebFetch(domain:)

`WebFetch(domain:x)` is a **tool permission, not a bash-network fence.** It maps to
a network allow for `x` **plus** an implicit `curl`/`wget` execpolicy allow, so
Codex reaches the host from the shell without a prompt. ✅ This deliberately grants
marginally more than Claude's *bash* would — Claude keeps a separate fetch channel
that bypasses the sandbox, and this collapses the two.

## Bash allow/deny rules → execpolicy

Claude's `permissions.allow` / `permissions.deny` Bash rules are written as a Codex
**execpolicy `.rules` file** in the isolated `CODEX_HOME`, auto-discovered and
enforced on **every** command, independent of the approval round-trip.

| Claude rule | Codex `decision` | Behaviour | |
|---|---|---|---|
| `permissions.deny` Bash | `forbidden` | Blocked unconditionally — including `auto`/`bypassPermissions` (fail-closed; catches wrapped / chained / env-prefixed commands). | ✅ |
| `permissions.allow` Bash | `allow` | Runs without prompting in every mode. | ✅ |

Codex takes the **strictest match**, so a prefix in both lists is `forbidden` —
mirroring Claude's "deny wins." The isolated home carries only Dragoman's derived
rules; the user's own `~/.codex/rules/*` are not read under Dragoman.

## Approvals & progress

| | → Codex | |
|---|---|---|
| Approvals for anything uncovered | **async native elicitation** — allow-rules auto-accept and deny-rules pre-decline in-process; the rest fire Claude's own approval prompt out-of-band (a blocking call would hit Claude's ~120 s tool ceiling). | ✅ |
| Codex progress | the ~80-type notification firehose collapses to a **sparse heartbeat**, surfaced by long-polling `codex_status`. | ✅ |

## Where it doesn't quite match

| Claude setting / expectation | Reality | |
|---|---|---|
| `sandbox.autoAllowBashIfSandboxed: false` — "prompt even sandboxable bash" | **Not faithfully mappable.** No Codex approval policy is stricter than `untrusted`, which still auto-runs Codex's own built-in *trusted* commands (`ls`, `cat`, …); execpolicy can't express "prompt everything except the allow-list" (empty patterns are rejected, `not_match` is a load-time assertion, not runtime negation). A user on `false` still sees trusted commands auto-run. The default (`true`) is honoured. | ❌ |
| `dontAsk` strictness | Faithful for your allow-rules, reads and writes — but Codex's built-in *trusted* commands still auto-run without a prompt (same execpolicy limitation). | ⚠️ |
