/**
 * The settings mirror (PLAN §10): Claude's posture → Codex thread policy.
 *
 * A pure function `mirror(settings, posture?) → CodexPolicy`, unit-tested with
 * no IO. The three-tier posture resolution (PLAN §10.2) lives at the call site:
 * an explicit `posture` (Claude filling in the live mode it knows but the server
 * can't read) wins; otherwise the static `defaultMode` from the merged files;
 * otherwise a safe default. This function just takes whichever mode won and maps
 * it, plus the sandbox/rules, onto Codex's knobs.
 */
import { isAbsolute } from "node:path";
import type { EffectiveSettings } from "./settings.ts";
import type { DomainAction, FsAccess, ManagedProfile, ProfileFilesystem } from "./codex-config.ts";
import type { AskForApproval } from "../generated/codex-protocol/ts/v2/AskForApproval.ts";
import type { ApprovalsReviewer } from "../generated/codex-protocol/ts/v2/ApprovalsReviewer.ts";
import type { ExecPolicyAmendment } from "../generated/codex-protocol/ts/ExecPolicyAmendment.ts";
import type { ModeKind } from "../generated/codex-protocol/ts/ModeKind.ts";

/**
 * Claude's permission modes (see code.claude.com/docs/en/permission-modes).
 *
 * **Manual mode** — reads-only, asks before most file/shell/network actions — has
 * the **config value `default`** (what hooks, the SDK, and `defaultMode` use); the
 * CLI also accepts **`manual`** as an alias for the same mode. Both are current and
 * map identically here. `posture` on a run accepts any of these so Claude can
 * supply the live mode the server can't read; `defaultMode` uses the same vocabulary.
 */
export type ClaudeMode =
  | "plan"
  | "default" // Manual mode's config value…
  | "manual" // …and its CLI alias — same mode
  | "acceptEdits"
  | "auto"
  | "dontAsk"
  | "bypassPermissions";

/** The Codex policy Dragoman applies to a thread/turn, mirroring Claude. */
export interface CodexPolicy {
  readonly approvalPolicy: AskForApproval;
  /**
   * Who adjudicates approval escalations. Orthogonal to `approvalPolicy` (which
   * says *when* to ask). `auto` mode leans into Codex's own model reviewer
   * (`auto_review`) — the analog to Claude's auto classifier. To reach the human,
   * Dragoman sets `user` explicitly: leaving it undefined does NOT default to
   * `user` headless — the probe showed it self-approves via internal agent review
   * — so undefined is reserved for postures with no reviewer (plan/bypass/dontAsk).
   */
  readonly approvalsReviewer?: ApprovalsReviewer;
  /**
   * What to do with a command approval the allow/deny prefixes don't settle:
   * `elicit` asks the human (Manual/acceptEdits/plan), `decline` refuses without
   * asking (`dontAsk` — "only pre-approved tools", never waits for input).
   */
  readonly commandFallback: "elicit" | "decline";
  /**
   * What to do with a file-change (edit) approval: `elicit` asks the human,
   * `accept` auto-approves (`acceptEdits`), `decline` refuses (`dontAsk`).
   */
  readonly fileChange: "elicit" | "accept" | "decline";
  /** execpolicy prefix allows, from Claude's `allow` Bash rules. */
  readonly execpolicyAmendments: readonly ExecPolicyAmendment[];
  /** Command token prefixes from Claude's `deny` Bash rules — pre-declined. */
  readonly denyPrefixes: readonly (readonly string[])[];
  /**
   * The permission profile this thread selects — the unified scope + network
   * axis. Absent for the `bypassPermissions` posture: `:danger-full-access` is
   * not an extendable profile base (Codex rejects it), and it means "no sandbox"
   * anyway, so that posture uses the `danger-full-access` sandbox enum instead.
   */
  readonly profile?: ManagedProfile;
  /**
   * Codex's native collaboration mode for this run — `plan` for Claude's plan
   * mode, undefined otherwise. When set, the run selects Codex's OWN plan posture
   * (`collaborationMode: {mode:"plan"}` on the turn), where the model is
   * instructed to investigate and produce a plan and REFUSES to write — verified
   * to reproduce Claude's plan semantics (a write becomes a refusal, never a
   * prompt). Only the mode is decided here; the required `settings.model` is
   * filled at the thread edge from the resolved thread model (`mirror` is pure and
   * doesn't know Codex's model). See docs/MAPPING.md.
   */
  readonly collaborationMode?: ModeKind;
}

/** The profile id for a base scope, e.g. `:workspace` → `dragoman-workspace`. */
export function profileIdForBase(base: string): string {
  return `dragoman-${base.slice(1)}`;
}

/**
 * The Codex profile base for this run — or `undefined` for **no profile**, meaning
 * `danger-full-access` (no OS sandbox).
 *
 * The scope axis is exactly "does this mode auto-allow writes?" — never granting
 * more than Claude's mode would. It governs the SHELL channel (what a command may
 * touch); the EDIT channel (apply_patch) is governed by the approval policy
 * (`approvalFor`), not by scope — the two must agree for a mode to actually auto-run
 * writes, which is why the auto-write modes ALSO get `granular` there, not just
 * `:workspace` here.
 *
 *   - `:workspace` for the **auto-write** modes: `acceptEdits` and `auto`. Here
 *     in-workspace shell writes run without a prompt (and, under their `granular`
 *     policy, so do in-workspace edits), matching Claude; an escape past the
 *     workspace raises a review.
 *   - `:read-only` for the **ask / no-auto-write** modes: `default`/`manual` (reads
 *     auto; a write/edit must ESCALATE → the human, mirroring Manual's "ask before
 *     edits" — verified), `plan` (explore, no writes — native plan mode enforces it),
 *     and `dontAsk` (writes aren't pre-approved, so they're refused). Giving these
 *     `:workspace` would let in-workspace writes run WITHOUT the prompt Claude
 *     requires — mirroring more permissively than Claude, which we never do.
 *   - `undefined` → `danger-full-access` for `bypassPermissions`: everything, no
 *     sandbox, no review.
 *
 * `readOnly` still triggers a review — a write is an escape past it — so the
 * reviewer/fallback (human / decline) handles it. The `filesystem`/`network`
 * tables refine the profile when Claude is sandboxing. See docs/MAPPING.md.
 */
function baseFor(_settings: EffectiveSettings, mode: ClaudeMode): string | undefined {
  if (mode === "bypassPermissions") return undefined; // danger-full-access: no sandbox
  if (mode === "acceptEdits" || mode === "auto") return ":workspace"; // auto-allow writes
  return ":read-only"; // plan / default / manual / dontAsk: writes escalate or are denied
}

/**
 * Claude's network posture as a profile's network rules: the coarse `enabled`
 * switch plus per-host allow/deny — `allowedDomains` and `WebFetch(domain:)` allow
 * rules become allows, `deniedDomains` become denies (Codex lets deny win).
 *
 * The per-host allowlist is the set of hosts the user has explicitly trusted, and it
 * is the FENCE regardless of the Codex sandbox (which is a separate, bash-confinement
 * axis): a `WebFetch(domain:x)` rule says "you may reach x", so x is allowed and other
 * hosts aren't — you'd have to approve or allow them. Codex has no fetch tool, so we
 * also emit an implicit `curl`/`wget` allow (see `fetchAllows`) so it can actually
 * reach the trusted host without a prompt; this allowlist scopes WHICH hosts it hits.
 */
function networkFor(settings: EffectiveSettings): { enabled: boolean; domains: [string, DomainAction][] } {
  const domains: [string, DomainAction][] = [];
  for (const host of settings.allowedDomains) domains.push([host, "allow"]);
  for (const rule of settings.allow) {
    const host = webFetchDomain(rule);
    if (host) domains.push([host, "allow"]);
  }
  for (const host of settings.deniedDomains) domains.push([host, "deny"]);
  return { enabled: networkEnabled(settings), domains };
}

/** The host of a `WebFetch(domain:...)` allow rule, or undefined. */
function webFetchDomain(rule: string): string | undefined {
  const match = /^WebFetch\(domain:([^)]+)\)$/.exec(rule.trim());
  return match ? match[1]!.trim() : undefined;
}

/**
 * Claude's four filesystem lists → the profile's `filesystem` axis.
 *
 * Each Claude list maps to one Codex access level by what it MEANS
 * (see [`MAPPING.md` → Filesystem](../docs/MAPPING.md)):
 *
 *   denyRead → deny   (no read, no write)
 *   denyWrite → read  (read-only — Claude's "no write, still readable", NOT deny)
 *   allowWrite → write
 *   allowRead → read
 *
 * A path may appear in several lists; deny wins and the more-restrictive level
 * wins (Codex agrees: `deny > write > read`), so we fold per UNIQUE path in that
 * priority — first assignment wins. Distinct paths are left for Codex to resolve
 * by narrowest-path. Absolute paths anchor to the top-level table; relative paths
 * and globs anchor under `:workspace_roots`, so they track the session's real
 * writable roots and stay portable across the isolated CODEX_HOME.
 */
export function filesystemFor(settings: EffectiveSettings): ProfileFilesystem {
  // Priority order: first to claim a path wins (deny is most restrictive).
  const chosen = new Map<string, FsAccess>();
  const claim = (paths: readonly string[], access: FsAccess): void => {
    for (const path of paths) {
      const key = path.trim();
      if (key !== "" && !chosen.has(key)) chosen.set(key, access);
    }
  };
  claim(settings.denyRead, "deny");
  claim(settings.denyWrite, "read");
  claim(settings.allowWrite, "write");
  claim(settings.allowRead, "read");

  const paths: [string, FsAccess][] = [];
  const workspaceRoots: [string, FsAccess][] = [];
  for (const [path, access] of chosen) {
    (isAbsolute(path) ? paths : workspaceRoots).push([path, access]);
  }
  return { paths, workspaceRoots };
}

/**
 * The ONE profile a thread selects — the whole scope + network + filesystem axis
 * for this run — or undefined for danger-full-access (no profile). This is what the
 * live path writes: `mirror` compiles exactly this from the composite settings + the
 * run's mode, and provision emits it into the per-run config. There is no pre-baked
 * pair — the old `allProfiles` (both scopes, emitted once) is gone; anything wanting
 * both scopes (test exec-probes) builds them explicitly from this function.
 */
export function profileFor(settings: EffectiveSettings, mode: ClaudeMode): ManagedProfile | undefined {
  const base = baseFor(settings, mode);
  if (base === undefined) return undefined; // danger-full-access: not a profile base
  return { id: profileIdForBase(base), base, network: networkFor(settings), filesystem: filesystemFor(settings) };
}

/** The safe default when no mode is known (PLAN §10.2 tier 3): `default` — Manual
 * mode's config value, and Claude's own built-in default in every server-relevant
 * context (`claude -p`, the SDK, no flags). Reads-only, ask for everything else. */
const SAFE_DEFAULT: ClaudeMode = "default";

/**
 * Map a Claude posture onto a Codex policy.
 *
 * `mode` is the already-resolved posture (explicit param ?? defaultMode ?? safe
 * default — resolved by the caller via `resolveMode`). The sandbox/isolation axis
 * is the `profile` (scope + network); the run's writable roots (cwd +
 * additionalDirectories) ride `runtimeWorkspaceRoots` at the thread edge.
 */
export function mirror(settings: EffectiveSettings, mode: ClaudeMode): CodexPolicy {
  const approvalPolicy = approvalFor(mode);
  const approvalsReviewer = reviewerFor(mode);
  // execpolicy allow-prefixes: the user's `allow` Bash rules, plus an implicit
  // curl/wget allow for a WebFetch rule (see `fetchAllows`). We do NOT add
  // acceptEdits's fs commands: under its `granular` policy an in-scope edit/command
  // already auto-runs, so a fs-command *approval* only fires for an ESCAPE.
  const execpolicyAmendments = fetchAllows(settings);
  const denyPrefixes = bashPrefixes(settings.deny);
  const profile = profileFor(settings, mode);
  return {
    approvalPolicy,
    approvalsReviewer,
    commandFallback: commandFallbackFor(mode),
    fileChange: fileChangeFor(mode),
    execpolicyAmendments,
    denyPrefixes,
    profile,
    collaborationMode: mode === "plan" ? "plan" : undefined,
  };
}

/**
 * Unmatched command approval: `dontAsk` and `plan` refuse without asking; others
 * ask the human. `plan` runs under Codex's native plan mode (the model refuses
 * writes at the source), so this is a backstop — a stray escape is declined, never
 * escalated, mirroring Claude plan where a write becomes a plan, not a prompt.
 */
function commandFallbackFor(mode: ClaudeMode): "elicit" | "decline" {
  return mode === "dontAsk" || mode === "plan" ? "decline" : "elicit";
}

/**
 * File-edit approval. `dontAsk`/`plan` refuse; everyone else asks the human.
 *
 * acceptEdits is NOT auto-accept HERE, and it doesn't need to be. Verified against
 * codex-cli 0.150.1: file edits (apply_patch) are gated by the APPROVAL POLICY, not
 * the sandbox — under `untrusted` every edit prompts even in-workspace, but under
 * acceptEdits's `granular` policy an in-workspace edit auto-runs with NO approval,
 * and only an ESCAPE (a write outside the writable roots) raises a fileChange
 * approval. So the only approval acceptEdits ever sees is an escape — which Claude
 * prompts for — hence `elicit`, the same as Manual. (Auto-accepting would grant the
 * out-of-scope write.) `granular` raises escapes DETERMINISTICALLY (4/4 in the
 * probe); `on-request` was flaky — one escape hard-failed with no prompt.
 */
function fileChangeFor(mode: ClaudeMode): "elicit" | "accept" | "decline" {
  if (mode === "dontAsk" || mode === "plan") return "decline";
  return "elicit";
}

/**
 * Resolve the effective mode from the three tiers (PLAN §10.2): an explicit
 * posture Claude passed wins; else the static merged `defaultMode`; else the
 * safe default. An unrecognised string falls through to the safe default rather
 * than erroring — a new Claude mode name should degrade, not break Codex.
 */
export function resolveMode(settings: EffectiveSettings, posture?: string): ClaudeMode {
  return asMode(posture) ?? asMode(settings.defaultMode) ?? SAFE_DEFAULT;
}

function asMode(value: string | undefined): ClaudeMode | undefined {
  switch (value) {
    case "plan":
    case "default":
    case "manual":
    case "acceptEdits":
    case "auto":
    case "dontAsk":
    case "bypassPermissions":
      return value;
    default:
      return undefined;
  }
}

/**
 * The `granular` approval policy that raises sandbox escapes for review.
 *
 * `on-request` leaves escalation to the model's discretion and (verified) does NOT
 * turn a sandbox denial into an approval event, so the review never fires. `granular`
 * with these toggles on DOES raise the escape — which is then adjudicated by the
 * `approvalsReviewer` (`user` → human, `auto_review` → Codex's model).
 */
const GRANULAR: AskForApproval = {
  granular: { sandbox_approval: true, request_permissions: true, rules: true, skill_approval: true, mcp_elicitations: true },
};

/**
 * Mode → Codex approval policy (verified against codex-cli 0.150.1).
 *
 * The key correction: file edits (apply_patch) are gated by THIS policy, not by the
 * sandbox scope. Under `untrusted` every edit prompts — even an in-workspace one
 * under a `:workspace` profile. Under `granular` an in-workspace edit auto-runs and
 * only an ESCAPE raises an approval. So the auto-write modes need `granular`, not a
 * mere `:workspace` scope, to actually auto-run edits.
 *
 *   - `auto` and `acceptEdits` → `granular`: in-workspace writes auto-run; escapes
 *     are raised DETERMINISTICALLY (4/4 in the probe; `on-request` was flaky — one
 *     escape hard-failed with no prompt). The two differ only in `reviewer` — `auto`
 *     routes escapes to Codex's model (`auto_review`), acceptEdits to the human.
 *   - `bypassPermissions` → `never`: everything, no checks.
 *   - `default`/`manual`/`dontAsk` → `untrusted`: reads auto; every edit/write is
 *     raised for review (human for Manual — "ask before edits", verified; declined
 *     for dontAsk).
 *   - `plan` → `on-request`, NOT `untrusted`: plan must READ freely (Claude plan
 *     explores without prompting), but `untrusted` raises an approval for non-trusted
 *     reads too, which plan's decline-fallback would then block. `on-request` lets
 *     reads auto-run and a write hard-fail closed; native plan mode refuses writes at
 *     the source regardless (verified: read auto-ran, write refused, no prompts).
 */
function approvalFor(mode: ClaudeMode): AskForApproval {
  switch (mode) {
    case "auto":
    case "acceptEdits":
      return GRANULAR;
    case "bypassPermissions":
      return "never";
    case "plan":
      // Reads must run freely (Claude plan explores without prompting). `untrusted`
      // raises an approval for any non-trusted command — INCLUDING reads — which the
      // decline-fallback would then block (verified: it blocked a `sed notes.txt`).
      // `on-request` lets reads auto-run and lets a write hard-fail closed; native
      // plan mode refuses writes at the source anyway (verified: read auto-ran
      // cmdReq=0, write refused). So plan reads freely and never writes, no prompts.
      return "on-request";
    case "default":
    case "manual":
    case "dontAsk":
      return "untrusted";
  }
}

/**
 * Mode → who adjudicates a raised approval (verified against codex-cli 0.150.1).
 *
 *   - `auto` → `auto_review`: Codex's model judges escapes with a risk framework —
 *     the faithful analog of Claude's auto classifier.
 *   - `default`/`manual`/`acceptEdits` → `user`: escapes route to the CLIENT
 *     (`item/…/requestApproval`) → our elicitation → the human. NOTE: this must be
 *     set EXPLICITLY — leaving it unset uses the internal agent review (self-
 *     approves), NOT the human, despite the protocol doc's "defaults to user".
 *   - `bypassPermissions` → none (never-ask). `dontAsk` → none: it refuses unmatched
 *     approvals via `commandFallback: "decline"` rather than routing anywhere.
 *   - `plan` → none: native plan mode makes the model refuse writes, so no escape is
 *     raised; the decline-fallback backstops any stray one without a human round-trip.
 *
 * Routing to Claude's OWN model isn't an option — Claude Code advertises no MCP
 * sampling (see the recorded finding). And the reviewer only bites under a sandbox
 * + `granular` policy: without a sandbox there's no escape to review.
 */
function reviewerFor(mode: ClaudeMode): ApprovalsReviewer | undefined {
  switch (mode) {
    case "auto":
      return "auto_review"; // Codex's model judges escapes (mirrors Claude's auto classifier)
    case "default":
    case "manual":
    case "acceptEdits":
      return "user"; // route escapes to the human via the elicitation seam
    default:
      return undefined; // plan / bypassPermissions / dontAsk: no reviewer needed
  }
}

/**
 * Whether Codex may reach the network, mirroring Claude's ACTUAL posture.
 *
 * When Claude is not sandboxing (`sandbox.enabled` unset — the common case), its bash
 * runs with FULL network, so Codex must too; denying it would mirror *more
 * restrictively than Claude*. Under Claude's sandbox, network is default-deny, opened
 * by a non-empty (or strict) allowlist — which can come from EITHER `sandbox.network`
 * OR `WebFetch(domain:...)` permission rules (Claude merges both), so either flips the
 * bool. The per-host `domains` fence (in `networkFor`) is emitted either way — it is
 * the set of trusted hosts, orthogonal to whether the coarse switch is on.
 */
function networkEnabled(settings: EffectiveSettings): boolean {
  if (!settings.sandboxEnabled) return true;
  return (
    settings.allowedDomains.length > 0 ||
    settings.strictAllowlist === true ||
    settings.allow.some(isWebFetchDomainAllow)
  );
}

/** A `WebFetch(domain:...)` allow rule — merged into Claude's sandbox network allowlist. */
function isWebFetchDomainAllow(rule: string): boolean {
  return /^WebFetch\(domain:/.test(rule.trim());
}

/**
 * Claude `allow`/`deny` Bash rules → command token prefixes.
 *
 * `Bash(npm run test:*)` → the token prefix `["npm","run","test"]`. From `allow`
 * these become execpolicy `prefix_rule(decision="allow")` amendments so matching
 * commands skip the prompt; from `deny` they are pre-declined in the approval
 * handler — the same commands Claude would auto-allow / block. Only `Bash(...)`
 * rules translate; `Read`/`Edit`/`WebFetch`/`mcp__…` rules are for other
 * surfaces. A bare `Bash` (no prefix) is dropped rather than becoming a
 * match-everything rule.
 */
function bashPrefixes(rules: readonly string[]): string[][] {
  const prefixes: string[][] = [];
  for (const rule of rules) {
    const prefix = bashPrefix(rule);
    if (prefix.length > 0) prefixes.push(prefix);
  }
  return prefixes;
}

/**
 * The execpolicy allow-prefixes for a run: the user's `allow` Bash rules, PLUS an
 * implicit `curl`/`wget` allow whenever a `WebFetch(domain:)` rule is present.
 *
 * A WebFetch permission means "you may reach this host". Codex has no fetch tool, so
 * the only way it can honour that is the shell — and it should reach the host WITHOUT
 * a prompt, mirroring Claude's fetch tool, which runs without asking. So a WebFetch
 * rule lets `curl`/`wget` run un-prompted; the per-host network allowlist
 * (`networkFor`) is what scopes WHICH hosts they can actually reach, so this broad
 * fetcher allow can only touch the trusted set. (It does grant slightly more than
 * Claude's bash — where you'd add a separate `Bash(curl:*)` rule — but that's the
 * deliberate, more-consistent model: trust the host, reach it however.)
 */
function fetchAllows(settings: EffectiveSettings): string[][] {
  const prefixes = bashPrefixes(settings.allow);
  if (settings.allow.some(isWebFetchDomainAllow)) prefixes.push(["curl"], ["wget"]);
  return prefixes;
}

/**
 * The command-token prefix of a `Bash(...)` rule, or [] if it isn't one.
 *
 * `Bash(npm run test:*)` → `["npm","run","test"]`. Claude's rule syntax uses a
 * trailing `:*` (or `*`) as the "and any arguments" wildcard; the prefix is the
 * tokens up to it. A token like `test:*` contributes its pre-`:` part (`test`)
 * then ends the prefix — everything after the wildcard is implicit. A bare
 * `Bash` (all commands) is deliberately NOT turned into an empty-prefix
 * allow-all, which would disable approval entirely.
 */
function bashPrefix(rule: string): string[] {
  const match = /^Bash\((.+)\)$/.exec(rule.trim());
  if (!match) return [];
  const inner = match[1]!.trim();
  const tokens: string[] = [];
  for (const token of inner.split(/\s+/)) {
    if (token === "*") break; // a standalone wildcard ends the prefix
    // `test:*` → keep `test`, then stop; a plain `*` inside (e.g. `foo*`) also stops.
    const wildcard = token.search(/[:*]/);
    if (wildcard === -1) {
      tokens.push(token);
    } else {
      const head = token.slice(0, wildcard);
      if (head !== "") tokens.push(head);
      break;
    }
  }
  return tokens;
}
