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
| **Approval** | permission `mode` | `approvalPolicy` + `approvalsReviewer` | _(to write — `auto → auto_review` locked)_ |
| **Exec rules** | `Bash(...)` allow/deny rules | execpolicy amendments + pre-declines | _(exists in `mirror.ts`)_ |

### Two orthogonal layers (the core correction)

Claude has two **independent** axes, and Codex mirrors each onto its own. The old
code conflated them (`baseFor(mode)` derived OS scope from the *mode*).

**1. Permission mode → prompting.** The mode governs whether Claude asks before an
action — for **both tool calls and bash**. `ask`/`default` prompts every time;
`acceptEdits` auto-approves edits, asks for the rest; `auto` model-judges;
`bypass`/`dontAsk` never ask; `plan` is read-only intent. → Codex's
**`approvalPolicy` (+ `approvalsReviewer`)**, plus `allow`/`deny` rules as
execpolicy allow-prefixes / pre-declines.

**2. Sandbox → OS confinement of the bash/terminal space only.** Claude's sandbox
confines **bash**; it never touches tool calls. → Codex's **`sandboxPolicy` scope
+ filesystem/network tables**.

They compose, and **sandbox-off is NOT `dangerFullAccess`.** `dangerFullAccess`
means *no confinement AND no prompting* — that is only `sandbox-off + auto/bypass`.
`sandbox-off + ask` is **unconfined bash that still prompts every time**.

#### WebFetch is a tool permission, not a network fence

`WebFetch(domain:…)` grants Claude's **WebFetch tool** reach to a host — a channel
**separate from bash**. With the sandbox on, bash `curl github.com` is blocked yet
the WebFetch tool still fetches github: the model gets access another way. So these
rules are tool permissions, **not** Claude's bash-network config, and they do
**not** map identically to any Codex knob (Codex reaches the network through its
sandboxed exec, not a distinct fetch tool).

**The resolved mapping (verified):** "you may reach host x" → a Codex network **allow**
for x PLUS an implicit **`curl`/`wget` execpolicy allow**, so Codex reaches x via the
shell WITHOUT a prompt — the fetch tool's no-ask behaviour, in Codex's one channel.
The per-host allowlist is the trusted-host fence, applied **regardless of the Codex
sandbox** (a separate bash-confinement axis): a host you named is reachable, others
aren't (you'd approve or allow them). This deliberately grants a little more than
Claude's *bash* would — Claude keeps a separate fetch channel that bypasses the
sandbox, which is exactly the smell we remove by folding host-trust into the one
sandbox. See the [WebFetch item under Open](#open) for the evidence.

#### Claude's permission modes (authoritative — [docs](https://code.claude.com/docs/en/permission-modes))

Modes are the **approval baseline**; the Bash sandbox is a *separate* axis for what
an action can reach ("the Bash sandbox and auto mode work independently and
combine"). Manual mode's **config value is `default`**; the CLI also accepts
`manual` for the same mode.

| mode | runs without asking |
|---|---|
| `default` / `manual` | reads only |
| `acceptEdits` | reads, file edits, common fs commands (`mkdir`/`touch`/`mv`/`cp`) |
| `plan` | reads, plus classifier-approved commands when `auto` is available |
| `auto` | everything, with background safety checks (the classifier) |
| `dontAsk` | **only pre-approved tools** (locked-down CI) — NOT the same as bypass |
| `bypassPermissions` | everything |

How Dragoman maps these onto Codex is the [Implemented mapping](#implemented-mapping)
below — settled and verified for `auto`; the others are provisional (see Open).

`auto` uses **`auto_review`** (locked): Codex's model classifies escalations — the
closest available analog to Claude's auto classifier, since routing to Claude's own
model isn't possible (no MCP sampling). It only bites in the **sandboxed** column,
where escapes exist to adjudicate — and even there it needs escalations to be
*raised* first (the `granular` policy; see Open).

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

## Approval mechanics — verified live against codex-cli 0.150.1

Empirically probed (`test/integration/autoreview.experiment.ts`), driving a real
app-server and reading the notification feed:

- **A sandbox is mandatory for *any* review.** `dangerFullAccess` (sandbox off) →
  no wall → the classifier never runs → every action just executes, whatever the
  reviewer. The check is literally "may I leave the sandbox?", so no sandbox = no
  check. So a *judged* mode needs a `workspaceWrite` sandbox even when Claude is
  unsandboxed — the sandbox is the review **trigger**, and the reviewer then grants
  the escapes (net: unconfined-but-judged).
- **`granular` is what fires the classifier — `on-request` does not.** Under
  `approvalPolicy: on-request`, sandbox denials just hard-fail; the model doesn't
  raise them. Under `granular{sandbox_approval, request_permissions, …}` the escape
  becomes an `item/autoApprovalReview/*` event.
- **`approvalsReviewer` is the human-vs-model switch** (under sandbox + granular):
  - `user` → routes the escape to the **client** (`item/commandExecution/requestApproval`
    → our elicitation → the human). **Deterministic (7/7).**
  - `auto_review` → Codex's **internal agent review** self-adjudicates
    (`decisionSource: "agent"`), risk-scoring and approving authorized escapes.
  - **unset ≠ explicit `user`.** Leaving the field off uses the internal agent
    review (self-approves), NOT client routing — so in headless the effective
    default is `auto_review`-like, despite the protocol doc's "defaults to `user`".
    You must set `user` explicitly to reach the human. (An earlier "user self-
    approved" result was this: an unset reviewer mislabeled as user.)
  - `guardian_subagent` → **no distinct behaviour at 0.150.1** — identical to
    `auto_review`. The whole guardian/auto-review API is `[UNSTABLE]` and
    `AutoReviewDecisionSource` has only the value `"agent"`, so no callback config
    differentiates it. Revisit when Codex stabilises it.
- **Two-tier safety:** the agent *self-regulates* first (it won't even attempt a
  clearly-forbidden action — a "never delete these" instruction produced 0 tool
  calls, no review), and the classifier reviews the escapes it *does* attempt.
- The review carries a real risk assessment: `status`
  (`approved`/`denied`/`timedOut`/…), `riskLevel`, `userAuthorization`
  (`low`/`medium`/`high`), and a `rationale`; its action types include
  `command`, `execve`, `applyPatch`, **`networkAccess`**, `mcpToolCall`,
  `requestPermissions` — so network egress is gated the same way.

<h3 id="implemented-mapping">Implemented mapping</h3>

What `mirror()` emits. The row governs the **escape / fallback** — a command or edit
the sandbox can't cover — carried to the pump by two per-run knobs: `commandFallback`
(unmatched command → `elicit`/`decline`) and `fileChange` (edit → `elicit`/`accept`/`decline`).

| Claude mode | scope | `approvalPolicy` | reviewer | native mode | `commandFallback` | `fileChange` | effect |
|---|---|---|---|---|---|---|---|
| `plan` | `readOnly` | **`on-request`** | — | **`plan`** | **decline** | **decline** | native plan mode: reads run freely, model **refuses writes at the source**, no prompt ✅ **verified** |
| `default`/`manual` | `readOnly` | untrusted | user | — | elicit | elicit | reads auto; **edit/write escalates → human, accept writes it** ✅ **verified** |
| `acceptEdits` | `workspaceWrite` | **`granular`** | user | — | elicit | elicit | in-ws edits **auto-run**; escapes → human ✅ **verified** |
| `auto` | `workspaceWrite` | `granular` | **`auto_review`** | — | elicit | elicit | escapes → model-judged ✅ **verified** |
| `dontAsk` | `readOnly` | untrusted | — | — | **decline** | **decline** | only pre-approved (allow rules) + reads run; writes/unmatched refused, never asks |
| `bypassPermissions` | `dangerFullAccess` | never | — | — | — | — | everything, unconfined, no check |

**The correction (verified against codex-cli 0.150.1).** Codex gates two channels
independently, and a mode maps onto *both*, not just the sandbox scope:

- **Shell commands** → the **sandbox scope**. `readOnly`: reads auto, writes escape.
  `workspaceWrite`: in-ws writes auto, escapes raise. `dangerFullAccess`: all auto.
- **File edits (apply_patch)** → the **approval policy**, NOT the sandbox. Under
  `untrusted` *every* edit prompts — even in-workspace under a `workspaceWrite`
  profile. Under `granular` an in-workspace edit auto-runs and only an escape raises
  (deterministically — 4/4 in the probe; `on-request` was flaky, one escape
  hard-failed silently). So the **auto-write modes need `granular`**, not merely a
  `:workspace` scope, to actually auto-run edits — this is why `acceptEdits` is
  `granular`, differing from `auto` only in `reviewer` (human vs model).
- **Plan** is a third axis: a **prompting posture** (`collaborationMode: {mode:"plan"}`),
  orthogonal to scope and policy. The model is instructed to investigate and refuses
  to write — reproducing Claude's plan semantics (a write becomes a plan, never a
  prompt). Its required `settings.model` is filled at the thread edge from the
  resolved thread model (`mirror` stays pure of Codex-side facts). Plan pairs it with
  **`on-request`**, not `untrusted`: plan must read freely, but `untrusted` raises an
  approval for non-trusted reads too, which the decline-fallback would then block
  (verified — it blocked a `sed`); `on-request` lets reads auto-run and writes
  hard-fail closed (verified: read auto-ran `cmdReq=0`, write refused).

The scope axis is still **"does the mode auto-allow writes?"** — `workspaceWrite` only
for `acceptEdits`/`auto`, `readOnly` for the ask/blocked modes, `dangerFullAccess`
only for `bypassPermissions` — but scope alone is not sufficient for edits; the
approval policy is the co-conspirator.

All rows except `dontAsk`/`bypassPermissions` are now **live-verified**
(`test/integration/modes.experiment.ts`, `acceptedits*.experiment.ts`,
`mapping-verify.experiment.ts`). Still not read: `autoAllowBashIfSandboxed`
(default `true`) — a user on the *regular* (non-auto-allow) sandbox would expect
in-workspace commands to prompt too. See Open.

## Open

### Config-layer command enforcement — execpolicy `.rules`

Dragoman's per-approval gates (`denyPrefixes`, `commandFallback`) fire **only inside
the approval handler**, which only runs on sandbox *escapes*. So a rule couldn't reach
in-workspace commands, nor `auto`/`bypassPermissions` (which round-trip no approval at
all). The fix — now implemented — is **config-layer enforcement**: `provision` writes
Claude's allow/deny Bash rules as a Codex **execpolicy `.rules` file** at
`CODEX_HOME/rules/dragoman.rules`, which Codex auto-discovers and enforces for EVERY
command, independent of the approval round-trip. (This is NOT a `config.toml` table —
execpolicy lives in `rules/*.rules`, a `prefix_rule(pattern=[…], decision=…)` DSL. The
per-approval `ExecPolicyAmendment` is literally "append an allow `prefix_rule`", so the
static equivalent is to write those lines ourselves.) See `renderRules` in
`codex-config.ts`. Verified live against codex-cli 0.150.1
(`execpolicy.integration.test.ts`, `execpolicy-bind.experiment.ts`):

- **[B] Claude `deny` Bash rules enforced in every mode** — ✅ FIXED. `deny` prefixes →
  `decision="forbidden"`: blocked unconditionally, **including `auto` and
  `bypassPermissions`** (verified: a `forbidden touch` is refused even under `never` +
  dangerFullAccess, and the "Claude deny rule" justification surfaces in the rejection).
- **Allow rules as an override** — ✅ DONE. `allow` prefixes → `decision="allow"`: the
  command runs **without prompting, in every mode** — an override over the mode's base
  (verified: an allowed `python3` runs with no client approval under `untrusted`/manual,
  where the same command otherwise prompts). Codex takes the strictest match, so a
  prefix in both lists is `forbidden` — mirroring Claude's "deny wins".
- **[A] `dontAsk` in-workspace commands** (partial). execpolicy can't express a
  default-deny-with-allowlist: matching is strictest-wins (`forbidden > prompt > allow`),
  so a catch-all `forbidden`/`prompt` would override the allow-list too. So `dontAsk`
  stays **pump-handled**: `untrusted` raises non-trusted in-workspace commands, and
  `commandFallback: "decline"` refuses them; allow-listed commands run via the config
  allow rule. Residual: Codex's own *trusted* commands (e.g. `ls`) auto-run in `dontAsk`
  without a prompt — a smaller gap to probe/close separately.
- **[C] acceptEdits auto-accepted escaped edits/commands** — ✅ FIXED
  (`081f87e`): acceptEdits now elicits escapes and injects no fs-command allows.

The isolated `CODEX_HOME` carries only Dragoman's derived rules (from Claude's config);
the user's own `~/.codex/rules/*` are not read under Dragoman, matching how the compiler
derives the whole posture from Claude.

### Fidelity / features

- **Live-probe the non-`auto` modes** — ✅ DONE for `manual`/`acceptEdits`/`plan`.
  Verified: a `readOnly` write-escape **does escalate to the human** (Manual writes
  after accept, `patch rejected by user` on decline — not a hard-fail); `acceptEdits`
  needs `granular` (not `untrusted`) for in-ws edits to auto-run while escapes still
  raise; `plan` uses Codex's **native plan mode**, where the model refuses writes with
  no prompt. Still to probe: `dontAsk`'s decline path leaving only allow-listed +
  read-only running once [A] is fixed.
- **`autoAllowBashIfSandboxed`** — ✅ resolved as a deliberate NON-change (docs +
  probes). It's a Claude sandbox-axis setting (`sandbox.autoAllowBashIfSandboxed`,
  default `true`) that only bites when Claude's sandbox is ON: then a *sandboxable*
  bash command auto-runs with **no prompt in every mode except plan** — "the sandbox
  boundary itself is the approval gate", which is exactly Codex's model.
  - `true` (default): manual/dontAsk stay **`untrusted`**. That prompts for a
    non-trusted in-sandbox bash command Claude's autoAllow would auto-run — a slight
    OVER-prompt, but safe (we never run *more* than Claude) and in character (manual =
    expect prompts). We do NOT switch to `on-request` (which would auto-run in-sandbox
    reads, matching autoAllow): `on-request` makes shell-write **escapes flaky**
    (verified 1/4 hard-failed with no prompt), undermining the reliable escape-prompt
    manual needs — whereas `untrusted` prompts every escape reliably. (Edits reliably
    prompt under both — verified 3/3 on-request — so that wasn't the deciding factor.)
    `plan` is the one mode autoAllow doesn't widen, and ours already gates it.
  - `false` ("prompt even sandboxable commands"): **not faithfully mappable.** No
    approvalPolicy is stricter than `untrusted` (which still auto-runs Codex's built-in
    *trusted* commands), and execpolicy can't express "prompt everything except the
    allow-list" — empty patterns are rejected (no catch-all) and `not_match` is a
    load-time assertion, not runtime negation. Residual (documented limitation): a
    user on `false` still sees Codex's trusted commands (`ls`, `cat`) auto-run.
- **Permissions requests** — ✅ wired through elicitation. When the agent asks to WIDEN
  its sandbox (`item/permissions/requestApproval` — add network / filesystem reach for
  the turn), the pump routes it to the human like the other approvals, showing the
  reason and exactly what's requested; `accept` grants what was asked (turn scope),
  anything else grants an empty profile (widens nothing). No intersection with Claude's
  `deny` rules — the human sees the request and decides (this is about sensible
  interactive mapping, not headless enforcement). `dontAsk`/`plan` refuse without
  asking (they never run `granular`, so never raise one). Only fires under `granular`
  (acceptEdits, or auto when the model reviewer defers). Handler logic is unit-tested
  (`pump.test.ts`); a deterministic live trigger for it isn't known, but the
  elicitation seam it rides is already verified.
- **WebFetch cross-channel mapping** — ✅ resolved + verified. A `WebFetch(domain:x)`
  rule means "you may reach host x". Codex has no fetch tool, so the mirror honours it
  two ways at once: a network **allow** for x AND an implicit **`curl`/`wget`
  execpolicy allow** (`fetchAllows`) — so Codex reaches x via the shell WITHOUT a
  prompt, the way Claude's fetch tool would. The per-host allowlist scopes WHICH hosts
  the fetchers can hit, and it's the trusted-host fence **regardless of the Codex
  sandbox** (a separate, bash-confinement axis). Verified (`webfetch.integration.test.ts`,
  `webfetch.experiment.ts`): under manual, a WebFetch-allowed host is reached with NO
  elicitation; a non-allowlisted host is blocked (the command runs un-prompted, the
  network fences it). This grants slightly more than Claude's *bash* would (there you'd
  add a separate `Bash(curl:*)`), but it's the deliberate, more-consistent model — trust
  the host, reach it however — since Claude's built-in tools bypassing the sandbox is
  the smell we're removing.
- **Caching decorator** over `provision` (per-run spawn is the core; reuse later).
