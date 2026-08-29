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
import type { EffectiveSettings } from "./settings.ts";
import type { AskForApproval } from "../generated/codex-protocol/ts/v2/AskForApproval.ts";
import type { SandboxMode } from "../generated/codex-protocol/ts/v2/SandboxMode.ts";
import type { SandboxPolicy } from "../generated/codex-protocol/ts/v2/SandboxPolicy.ts";
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
  /** Enum form for `thread/start`. */
  readonly sandbox: SandboxMode;
  /** Structured form for `turn/start` / `thread/settings/update`. */
  readonly sandboxPolicy: SandboxPolicy;
  /** execpolicy prefix allows, from Claude's `allow` Bash rules. */
  readonly execpolicyAmendments: readonly ExecPolicyAmendment[];
  /** Command token prefixes from Claude's `deny` Bash rules — pre-declined. */
  readonly denyPrefixes: readonly (readonly string[])[];
}

/** The safe default when no mode is known (PLAN §10.2 tier 3): ask, read-only. */
const SAFE_DEFAULT: ClaudeMode = "default";

/**
 * Map a Claude posture onto a Codex policy.
 *
 * `mode` is the already-resolved posture (explicit param ?? defaultMode ?? safe
 * default — resolved by the caller via `resolveMode`). `cwd` is the run's
 * working directory, always a writable root under a write sandbox.
 */
export function mirror(settings: EffectiveSettings, mode: ClaudeMode, cwd: string): CodexPolicy {
  const approvalPolicy = approvalFor(mode);
  const sandbox = sandboxModeFor(mode, settings);
  const sandboxPolicy = sandboxPolicyFor(sandbox, settings, cwd);
  const execpolicyAmendments = bashPrefixes(settings.allow);
  const denyPrefixes = bashPrefixes(settings.deny);
  return { approvalPolicy, sandbox, sandboxPolicy, execpolicyAmendments, denyPrefixes };
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

/** Mode + sandbox settings → the enum sandbox for thread/start (PLAN §10.3). */
function sandboxModeFor(mode: ClaudeMode, settings: EffectiveSettings): SandboxMode {
  if (mode === "plan") return "read-only";
  if (mode === "bypassPermissions") return "danger-full-access";
  // Everything else writes within the workspace. `sandbox.enabled:false` in
  // Claude doesn't loosen this — Codex still benefits from a workspace boundary,
  // and mirroring "hotter than Claude" is the one thing we never do.
  return "workspace-write";
}

/** The structured SandboxPolicy for per-turn use, carrying dirs + network. */
function sandboxPolicyFor(sandbox: SandboxMode, settings: EffectiveSettings, cwd: string): SandboxPolicy {
  switch (sandbox) {
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    case "read-only":
      return { type: "readOnly", networkAccess: networkEnabled(settings) };
    case "workspace-write":
      return {
        type: "workspaceWrite",
        // The cwd is always writable; additionalDirectories extend it.
        writableRoots: [cwd, ...settings.additionalDirectories],
        networkAccess: networkEnabled(settings),
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
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
  return settings.allowedDomains.length > 0 || settings.strictAllowlist === true;
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
