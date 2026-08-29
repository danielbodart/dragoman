# Mirror Verification — does Codex actually honour what Dragoman mirrors?

Unit tests prove Dragoman **emits** the right Codex policy from a given Claude
posture (`mirror.test.ts`). They do **not** prove Codex **honours** it. This doc
is the empirical other half: each mapping is exercised by a live `codex_run`
probe through Dragoman, and the observed behaviour is recorded here as
manually-confirmed.

Verified against `codex-cli 0.150.1`, Dragoman binary built from the commit noted
in each result. Re-run after a Codex upgrade.

## Now an executable, ratcheting suite

These probes are now **live integration tests** under `test/integration/`, not
just a manual log — this doc is the human-readable index; the tests are the
executable truth. They are ratcheted (`verifyOnce`): each runs once until green,
records a marker under `test/integration/.state/`, then is skipped; `bun test`
on a machine without `codex` skips them entirely. Delete a marker (or the whole
`.state/` dir) to re-run. The sandbox/network rows use the model-free
`command/exec` RPC (deterministic, free); the approval rows spend one real turn
each.

**Key finding (codex-cli 0.150.1):** the app-server round-trips
`item/commandExecution/requestApproval` to the client only under
`approvalPolicy: untrusted` (Claude's `plan` posture). Under `on-request` Codex
self-approves via an internal `item/autoApprovalReview` and **does not** ask the
client. So Dragoman's elicitation bridge is chiefly exercised in `plan` mode;
`on-request` modes lean on Codex's own review plus the sandbox boundary.

## How a probe works

A probe is a `codex_run` under a chosen `posture`, phrased so Codex's own
behaviour reveals whether the mirrored policy took effect — then we read the
result (or the `waiting-approval` status) back through `codex_status`.

Two probe classes:

- **Non-interactive** — posture maps to `approvalPolicy: never`, so a
  sandbox-blocked action doesn't prompt; Codex just gets an error it reports back.
  The result string is the evidence. (`dontAsk` → never+workspace-write;
  `bypassPermissions` → never+danger-full-access.)
- **Interactive** — posture maps to an asking `approvalPolicy`
  (`plan`→untrusted, `default`→on-request). The evidence is that an elicitation
  fires (`status: waiting-approval`) — or, for execpolicy allow, that it does
  **not** fire. These need a human to observe/answer the prompt.

Each probe batch runs against a freshly-reconnected MCP server (so it uses the
current binary). To take the human out of the loop, a probe is driven by a
headless `claude -p --dangerously-skip-permissions` subprocess that spawns its
own fresh Dragoman MCP server, calls `codex_run`, and polls `codex_status`.

**Limitation of the headless driver:** `claude -p` *auto-answers* MCP
elicitations, so it cannot directly witness a `waiting-approval` state — a fired
approval is instantly accepted and looks like a clean run. Manual probing can
therefore only *cleanly* verify the `never`-posture sandbox/network mappings
(where a blocked action errors instead of prompting). A fired approval can still
be shown *by contrast* (an action that a `never` posture rejects but an
`on-request` posture completes was necessarily granted via an approval). Rows
that need to assert an approval *prompted* — and the execpolicy allow-skip, whose
whole point is that no prompt fires — need the injectable-elicitation test
harness (an in-test `ElicitationChannel` double that records asks and scripts the
decision). That harness is deferred to avoid burning model tokens on every run.

## Legend

✅ confirmed · ❌ contradicted mapping (bug) · ⏳ not yet run · 🚧 mapping not yet implemented

---

## Implemented mappings

### A. Permission mode → approvalPolicy + sandbox (`mirror.ts` `approvalFor`/`sandboxModeFor`)

| # | Posture | Emitted policy | Probe | Expected observable | Actual | Verdict |
|---|---|---|---|---|---|---|
| A1 | `bypassPermissions` | never + danger-full-access | write `~/.dragoman-probe-a1.txt` (outside workspace) | write **succeeds**, no prompt | write succeeded; file confirmed on disk | ✅ |
| A2 | `dontAsk` | never + workspace-write | write `./probe-a2-in.txt` (cwd) **and** `~/.dragoman-probe-a2-out.txt` (outside); report both | in-cwd **succeeds**; outside **fails**, no prompt | in-cwd wrote; outside rejected — *"writing outside of the project; rejected by user approval settings"*, file absent | ✅ |
| A3 | `plan` | untrusted + read-only | write under a read-only policy | write blocked | `sandbox.integration.test.ts` — read-only blocks writes (exit ≠ 0), allows reads | ✅ test |
| A4 | `default` | on-request + workspace-write | write outside cwd (`~/.dragoman-probe-a4.txt`) | **approval fires**, then (if granted) write succeeds | outside write **succeeded** where the identical write under `never` (A2) was **rejected** — success is reachable only via a granted approval, so on-request **did** fire an approval (auto-answered by the headless probe) | ✅ by contrast |
| A5 | `manual` / `acceptEdits` / `auto` | on-request + workspace-write (identical to `default`) | mapping only | same Codex policy as `default` — the difference is left to Codex | `mirror.test.ts` asserts each → on-request + workspace-write | ✅ unit |

**On `auto`:** it maps to `on-request` deliberately, not incidentally. Claude
`auto` mode delegates the accept/decline call to a *model*; Codex `on-request`
delegates it to a *model* too (its internal `item/autoApprovalReview`). The job
is only to ensure both use a model for that judgment — not to make Codex's model
reach the same verdict as Claude's. Note the proven consequence (see the key
finding): under `on-request` Codex's review is a **closed loop** — it never
round-trips to the Dragoman client (verified even for `sudo`), so in these modes
the human is not prompted; Codex's own review plus the sandbox are the guard. The
elicitation bridge is reached only under `plan`/`untrusted`.

### B. Sandbox scope (`sandboxModeFor` / `sandboxPolicyFor`)

| # | Posture / setting | Emitted policy | Probe | Expected observable | Actual | Verdict |
|---|---|---|---|---|---|---|
| B1 | `dontAsk` (workspace-write) | writableRoots = [cwd] | read a file in cwd, then write in cwd | both **succeed** | in-cwd write confirmed by A2 & B2; reads are unrestricted under every sandbox | ✅ (via A2/B2) |
| B2 | `dontAsk`, `additionalDirectories: [/home/dan/dragoman-extra]` | writableRoots = [cwd, that dir] | write into that extra dir | **succeeds** (proves writableRoots carried) | write to the outside dir **succeeded** (A2's outside write was rejected); file confirmed | ✅ |
| B3 | `plan` (read-only) | readOnly | read a file, then attempt a write | read ok; write blocked | `sandbox.integration.test.ts` — read succeeds (exit 0), write blocked (exit ≠ 0) | ✅ test |

### C. Network access bool (`networkEnabled`)

| # | Posture / setting | Emitted policy | Probe | Expected observable | Actual | Verdict |
|---|---|---|---|---|---|---|
| C1 | no Claude sandbox (`sandbox.enabled` unset) | networkAccess = **true** | `curl` | **succeeds** — mirrors Claude's own full network | `sandbox.integration.test.ts` — curl exit 0 | ✅ test |
| C2 | `sandbox.enabled: true`, no allowlist | networkAccess = false | `curl` | **fails** (network blocked) | `sandbox.integration.test.ts` — curl exit ≠ 0 | ✅ test |
| C3 | `sandbox.enabled: true`, `allowedDomains: ["example.com"]` | networkAccess = true | `curl` | **succeeds** | `sandbox.integration.test.ts` — curl exit 0 | ✅ test |

**Correction (feel-test finding):** `networkEnabled` originally defaulted to
**deny** unless an allowlist was present — but when Claude is not sandboxing (the
common case) Claude's own tools have **full network**, so denying it to Codex
mirrored *more restrictively than Claude*, the one direction we never go. Now
network is open unless Claude is actively sandboxing; only under Claude's sandbox
is it default-deny, with an allowlist opening it. It remains a **coarse bool** —
an allowlist opens *all* network, not only the listed hosts (per-host restriction
is the deferred network-host mapping below).

Verified against the Claude Code docs (code.claude.com, 2.1.250): sandbox and
permissions are **orthogonal** — the sandbox does OS-level network/fs isolation
for Bash, permission modes govern tool prompting; permission mode (incl. `auto`)
does **not** affect Bash network. The allowlist that opens sandbox network can
come from **either** `sandbox.network.allowedDomains` **or** `WebFetch(domain:…)`
allow rules (Claude merges both), so `networkEnabled` honours both.

### D. Approval handler — allow auto-accept / deny pre-decline (`pump.ts`)

Verified live under `plan` (untrusted), the posture that actually round-trips
approvals (see the key finding above); `pump.test.ts` unit-covers the same logic
against `FakeAppServer`, including the compound-command security guard.

| # | Setting | Behaviour | Evidence | Verdict |
|---|---|---|---|---|
| D1 | `allow: ["Bash(echo dragoman-probe:*)"]` | matching command auto-accepted, no prompt | `approval.integration.test.ts` — allow rule → `asks == 0` (elicitation never fired) | ✅ test |
| D2 | no matching rule | command prompts the human | `approval.integration.test.ts` — unmatched → `asks > 0` (elicitation fired) | ✅ test |
| D3 | `deny: ["Bash(echo:*)"]` | matching command pre-declined, no prompt | `approval.integration.test.ts` — deny rule → `asks == 0`, Codex logs `Rejected("rejected by user")` | ✅ test |
| D4 | compound command NOT auto-accepted (security fix) | — | `pump.test.ts` unit regression (live-fire flaky on model phrasing) | ✅ unit |

---

## Not-yet-implemented mappings (build, then probe)

| Claude setting | Codex target | Status | Note |
|---|---|---|---|
| `permissions.deny` Bash rules | pre-decline in approval handler | ✅ built | unit-tested (`mirror.test.ts` deny prefixes, `pump.test.ts` pre-decline incl. wrapped/chained/env-prefixed fail-closed cases + deny-wins-over-allow); live-fire needs the harness |
| `sandbox.network.allowedDomains`/`deniedDomains` (specific hosts) | `NetworkPolicyAmendment{host,action}` / thread `config` | 🚧 | only the coarse bool is mapped today; host lists need the freeform config surface |
| `sandbox.filesystem.allowRead/denyRead/allowWrite/denyWrite` | `AdditionalFileSystemPermissions` via named permissions profile | 🚧 | not in the typed RPC struct; PLAN §10.4 "later lever" |

---

_Probe log started 2026-08-29. Fill Actual/Verdict as each batch runs._
