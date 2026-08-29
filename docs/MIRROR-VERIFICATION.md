# Mirror Verification — does Codex actually honour what Dragoman mirrors?

Unit tests prove Dragoman **emits** the right Codex policy from a given Claude
posture (`mirror.test.ts`). They do **not** prove Codex **honours** it. This doc
is the empirical other half: each mapping is exercised by a live `codex_run`
probe through Dragoman, and the observed behaviour is recorded here as
manually-confirmed.

Verified against `codex-cli 0.150.1`, Dragoman binary built from the commit noted
in each result. Re-run after a Codex upgrade.

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
| A3 | `plan` | untrusted + read-only | write `./probe-plan.txt` | write blocked / **approval fires** (`waiting-approval`) | — | 🚧 needs harness |
| A4 | `default` | on-request + workspace-write | write outside cwd (`~/.dragoman-probe-a4.txt`) | **approval fires**, then (if granted) write succeeds | outside write **succeeded** where the identical write under `never` (A2) was **rejected** — success is reachable only via a granted approval, so on-request **did** fire an approval (auto-answered by the headless probe) | ✅ by contrast |

### B. Sandbox scope (`sandboxModeFor` / `sandboxPolicyFor`)

| # | Posture / setting | Emitted policy | Probe | Expected observable | Actual | Verdict |
|---|---|---|---|---|---|---|
| B1 | `dontAsk` (workspace-write) | writableRoots = [cwd] | read a file in cwd, then write in cwd | both **succeed** | in-cwd write confirmed by A2 & B2; reads are unrestricted under every sandbox | ✅ (via A2/B2) |
| B2 | `dontAsk`, `additionalDirectories: [/home/dan/dragoman-extra]` | writableRoots = [cwd, that dir] | write into that extra dir | **succeeds** (proves writableRoots carried) | write to the outside dir **succeeded** (A2's outside write was rejected); file confirmed | ✅ |
| B3 | `plan` (read-only) | readOnly | read a file, then attempt a write | read ok; write blocked | — | 🚧 needs harness (write-block masked by headless auto-accept) |

### C. Network access bool (`networkEnabled`)

| # | Posture / setting | Emitted policy | Probe | Expected observable | Actual | Verdict |
|---|---|---|---|---|---|---|
| C1 | `dontAsk`, no network allowlist | networkAccess = false | `curl -sS https://example.com` and report outcome | **fails** (network blocked) | `curl: (6) Could not resolve host: example.com` — network blocked | ✅ |
| C2 | `dontAsk`, `sandbox.network.allowedDomains: ["example.com"]` | networkAccess = true | same curl | **succeeds** | `curl example.com` → **HTTP 200** (C1 without the allowlist failed DNS) | ✅ (coarse bool only¹) |

¹ `networkEnabled` flips the coarse `networkAccess` bool; a non-empty allowlist opens **all** network, not only the listed hosts. Per-host restriction is the deferred network-host mapping below — a curl to an *un*listed domain would also succeed today.

### D. Execpolicy allow → auto-accept (`pump.ts` `commandTokenCandidates`)

| # | Posture / setting | Behaviour | Probe | Expected observable | Actual | Verdict |
|---|---|---|---|---|---|---|
| D1 | `default`, `allow: ["Bash(echo probe:*)"]` | matching command auto-accepted with `acceptWithExecpolicyAmendment` | ask Codex to run `echo probe hello` | runs with **no human prompt** (no `waiting-approval`) | — | 🚧 needs harness (headless auto-accepts, so "no prompt" is unobservable) |
| D2 | `default`, same allow | non-matching command still prompts | ask Codex to run a different escalating command | **approval fires** | — | 🚧 needs harness |
| D3 | `default`, `allow: ["Bash(echo probe:*)"]` | compound command NOT auto-accepted (security fix) | ask Codex to run `echo probe hello && id` | **approval fires** (not auto-accepted) | covered by the `pump.test.ts` unit regression; live-fire needs harness | 🚧 needs harness |

---

## Not-yet-implemented mappings (build, then probe)

| Claude setting | Codex target | Status | Note |
|---|---|---|---|
| `permissions.deny` Bash rules | pre-decline in approval handler | 🚧 | clean, typed, testable — next to build |
| `sandbox.network.allowedDomains`/`deniedDomains` (specific hosts) | `NetworkPolicyAmendment{host,action}` / thread `config` | 🚧 | only the coarse bool is mapped today; host lists need the freeform config surface |
| `sandbox.filesystem.allowRead/denyRead/allowWrite/denyWrite` | `AdditionalFileSystemPermissions` via named permissions profile | 🚧 | not in the typed RPC struct; PLAN §10.4 "later lever" |

---

_Probe log started 2026-08-29. Fill Actual/Verdict as each batch runs._
