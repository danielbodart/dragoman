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
import type { ExecPolicyAmendment } from "../generated/codex-protocol/ts/ExecPolicyAmendment.ts";

/**
 * Claude's permission modes. `posture` on a run accepts one of these so Claude
 * can supply the live mode the MCP server cannot read; the static file value
 * (`defaultMode`) is the same vocabulary.
 */
export type ClaudeMode =
  | "plan"
  | "default"
  | "manual"
  | "acceptEdits"
  | "auto"
  | "dontAsk"
  | "bypassPermissions";

/** The Codex policy Dragoman applies to a thread/turn, mirroring Claude. */
export interface CodexPolicy {
  readonly approvalPolicy: AskForApproval;
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
}

/** Dragoman's managed profile bases — the two Codex lets a profile extend. */
export const PROFILE_BASES = [":read-only", ":workspace"] as const;

/** The profile id for a base scope, e.g. `:workspace` → `dragoman-workspace`. */
export function profileIdForBase(base: string): string {
  return `dragoman-${base.slice(1)}`;
}

/** The built-in Codex base scope for a non-danger Claude mode. */
function baseFor(mode: ClaudeMode): string {
  return mode === "plan" ? ":read-only" : ":workspace";
}

/**
 * Claude's network posture as a profile's network rules: the coarse `enabled`
 * switch plus per-host allow/deny — `allowedDomains` and `WebFetch(domain:)` allow
 * rules become allows, `deniedDomains` become denies (Codex lets deny win).
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
 * Each Claude list maps to one Codex access level by what it MEANS (PLAN §10.4,
 * [`FILESYSTEM-MAPPING.md`](../docs/FILESYSTEM-MAPPING.md)):
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

/** The profile a thread at this posture selects, or undefined for danger (no profile). */
export function profileFor(settings: EffectiveSettings, mode: ClaudeMode): ManagedProfile | undefined {
  if (mode === "bypassPermissions") return undefined; // danger-full-access: not a profile base
  const base = baseFor(mode);
  return { id: profileIdForBase(base), base, network: networkFor(settings), filesystem: filesystemFor(settings) };
}

/**
 * All profiles Dragoman writes into the isolated config — one per base scope,
 * sharing the same network rules — so any posture's thread can select its scope
 * from a config generated once when codex is spawned.
 */
export function allProfiles(settings: EffectiveSettings): ManagedProfile[] {
  const network = networkFor(settings);
  const filesystem = filesystemFor(settings);
  return PROFILE_BASES.map((base) => ({ id: profileIdForBase(base), base, network, filesystem }));
}

/** The safe default when no mode is known (PLAN §10.2 tier 3): ask, read-only. */
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
  const execpolicyAmendments = bashPrefixes(settings.allow);
  const denyPrefixes = bashPrefixes(settings.deny);
  const profile = profileFor(settings, mode);
  return { approvalPolicy, execpolicyAmendments, denyPrefixes, profile };
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

/** Mode → Codex approval policy (PLAN §10.3). */
function approvalFor(mode: ClaudeMode): AskForApproval {
  switch (mode) {
    case "plan":
      return "untrusted"; // ask before acting; read-only anyway
    case "bypassPermissions":
    case "dontAsk":
      return "never"; // Claude would not prompt, so neither does Codex
    case "default":
    case "manual":
    case "acceptEdits":
    case "auto":
      return "on-request"; // ask when Codex hits something the sandbox can't cover
  }
}

/**
 * Whether Codex may reach the network, mirroring Claude's ACTUAL posture.
 *
 * The correction: when Claude is not sandboxing (`sandbox.enabled` unset — the
 * common case), Claude's own tools run with FULL network, so denying it to Codex
 * would mirror *more restrictively than Claude* — the one direction we never go.
 * So network is open unless Claude is actively sandboxing. Only under Claude's
 * sandbox is network default-deny, with a non-empty (or strict) allowlist opening
 * it. (Specific host allow/deny lists map onto Codex's network policy separately;
 * here we only flip the coarse switch.)
 */
function networkEnabled(settings: EffectiveSettings): boolean {
  if (!settings.sandboxEnabled) return true;
  // Under Claude's sandbox the allowlist can come from EITHER sandbox.network
  // OR `WebFetch(domain:...)` permission rules — Claude merges both into the
  // sandbox network config, so either opening network must flip the bool.
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
