/**
 * Dragoman's runtime observability probe — a permanent operator tool.
 *
 * It answers, as ONE structured object, two questions no log line outside the
 * subprocess can: WHAT does the bridge actually see (cwd, which `CLAUDE_*` env,
 * which settings files are reachable, and what those settings would mirror onto
 * Codex for each posture), and WHAT is it doing right now (the live runs, their
 * status, active turn, context %, and latest structured event). The first half
 * diagnoses a mirror that fired wrong; the second diagnoses a run that is stuck,
 * waiting, or unaccounted for. As the tool surface grows past
 * `codex_run`/`codex_status`, this stays the single ground-truth view — and, like
 * every other tool, it returns structured data, not prose.
 *
 * It deliberately reports settings-file *presence* and their permission/sandbox
 * KEYS + counts, never full file contents, so nothing sensitive lands in the
 * transcript.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { mirror, resolveMode } from "./mirror.ts";
import { readSettings } from "./settings.ts";
import type { ThreadRuns } from "./thread-run.ts";
import type { RunEvent, RunUsage } from "./model.ts";
import { version } from "./version.ts";

/** One live (or recently-settled) run, as the probe reports it. */
export interface ActiveRun {
  readonly handle: string;
  readonly status: string;
  /** The active turn id a cancel/steer/continue names, or null before the first turn. */
  readonly turnId: string | null;
  /** This thread's context-window occupancy as a percentage, or null if unseen. */
  readonly ctx: number | null;
  /** The newest undrained event, or null — best-effort colour on top of `status`
   * (a poll may already have drained the log). The full structured event, verbatim. */
  readonly latest: RunEvent | null;
}

/** A reachable settings file's presence and permission/sandbox shape — keys and
 * counts only, never rule contents. */
export interface SettingsFile {
  readonly label: string;
  readonly path: string;
  readonly present: boolean;
  readonly keys?: readonly string[];
  readonly permissions?: PermissionsSummary;
  readonly sandbox?: SandboxSummary;
  readonly error?: string;
}

interface PermissionsSummary {
  readonly defaultMode?: string;
  readonly allow?: number;
  readonly deny?: number;
  readonly ask?: number;
  readonly additionalDirectories?: number;
}

interface SandboxSummary {
  readonly enabled?: boolean;
  readonly filesystem?: readonly string[];
  readonly network?: readonly string[];
}

/** One posture's mirrored Codex policy — the settings-mirror pipeline exercised. */
export interface MirrorPosture {
  readonly posture: string | null;
  readonly mode: string;
  readonly approvalPolicy: unknown;
  readonly profile: string | null;
  readonly execpolicyAmendments?: readonly (readonly string[])[];
}

/** The whole probe, as one structured object returned via `structuredContent`. */
export interface DiagnosticsReport {
  readonly version: string;
  readonly activeRuns: readonly ActiveRun[];
  /** The account-global rate-limit windows (5h / weekly) as percentages used —
   * accumulated in the background, reported here rather than on every status poll.
   * Each run's own context percentage rides its `ActiveRun.ctx`. */
  readonly rateLimits: RunUsage;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | null>>;
  readonly projectDir: string;
  readonly configDir: string;
  readonly settingsFiles: readonly SettingsFile[];
  readonly mirror: {
    readonly effective: {
      readonly defaultMode: string | null;
      readonly allow: number;
      readonly deny: number;
      readonly additionalDirectories: readonly string[];
      readonly sandboxEnabled: boolean;
      readonly allowedDomains: number;
    };
    readonly postures: readonly MirrorPosture[];
  };
}

/**
 * Build the structured probe. `runs` is optional so the pure env/mirror halves
 * still work without a registry (e.g. a smoke test); when present, `activeRuns`
 * lists every in-flight Codex run so an operator can see what each is doing.
 */
export function diagnostics(runs?: ThreadRuns): DiagnosticsReport {
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const settings = readSettings(process.env);

  return {
    version,
    activeRuns: activeRuns(runs),
    rateLimits: runs?.accountLimits() ?? {},
    cwd: process.cwd(),
    env: envSnapshot(),
    projectDir,
    configDir,
    settingsFiles: settingsFiles(projectDir, configDir),
    mirror: {
      effective: {
        defaultMode: settings.defaultMode ?? null,
        allow: settings.allow.length,
        deny: settings.deny.length,
        additionalDirectories: settings.additionalDirectories,
        sandboxEnabled: settings.sandboxEnabled ?? false,
        allowedDomains: settings.allowedDomains.length,
      },
      // What Dragoman would actually mirror onto Codex right now, per posture.
      postures: [undefined, "plan", "bypassPermissions"].map((posture): MirrorPosture => {
        const mode = resolveMode(settings, posture);
        const policy = mirror(settings, mode);
        return {
          posture: posture ?? null,
          mode,
          approvalPolicy: policy.approvalPolicy,
          profile: policy.profile?.id ?? null,
          ...(policy.execpolicyAmendments.length > 0 ? { execpolicyAmendments: policy.execpolicyAmendments } : {}),
        };
      }),
    },
  };
}

/** The Claude Code env vars the bridge cares about, each present-or-null. */
function envSnapshot(): Record<string, string | null> {
  const names = [
    "CLAUDE_PROJECT_DIR",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_PLUGIN_ROOT",
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_MCP_SERVER_NAME",
    "PWD",
  ];
  const snapshot: Record<string, string | null> = {};
  for (const name of names) snapshot[name] = process.env[name] ?? null;
  return snapshot;
}

/**
 * Every in-flight (and recently-settled) run the registry still holds, with the
 * ids a cancel/steer/continue needs and the newest event. No registry (pure
 * call) → an empty list.
 */
function activeRuns(runs?: ThreadRuns): ActiveRun[] {
  if (!runs) return [];
  const out: ActiveRun[] = [];
  for (const handle of runs.handles()) {
    const run = runs.status(handle);
    if (!run) continue;
    out.push({
      handle,
      status: run.status,
      turnId: run.turnId ?? null,
      ctx: run.ctx ?? null,
      latest: run.events.at(-1) ?? null,
    });
  }
  return out;
}

/** The candidate settings roots we could mirror from, in precedence order (low→high). */
function settingsFiles(projectDir: string, configDir: string): SettingsFile[] {
  const candidates = [
    { label: "user", path: join(configDir, "settings.json") },
    { label: "user-local", path: join(configDir, "settings.local.json") },
    { label: "project", path: join(projectDir, ".claude", "settings.json") },
    { label: "project-local", path: join(projectDir, ".claude", "settings.local.json") },
  ];
  return candidates.map(({ label, path }): SettingsFile => {
    if (!existsSync(path)) return { label, path, present: false };
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      return {
        label,
        path,
        present: true,
        keys: Object.keys(parsed),
        permissions: summarizePermissions(parsed.permissions),
        sandbox: summarizeSandbox(parsed.sandbox),
      };
    } catch (error) {
      return { label, path, present: true, error: (error as Error).message };
    }
  });
}

/** The permission-relevant shape, as keys + counts — never rule contents. */
function summarizePermissions(permissions: unknown): PermissionsSummary | undefined {
  if (!permissions || typeof permissions !== "object") return undefined;
  const p = permissions as Record<string, unknown>;
  const summary: { defaultMode?: string; allow?: number; deny?: number; ask?: number; additionalDirectories?: number } = {};
  if (typeof p.defaultMode === "string") summary.defaultMode = p.defaultMode;
  for (const key of ["allow", "deny", "ask", "additionalDirectories"] as const) {
    if (Array.isArray(p[key])) summary[key] = (p[key] as unknown[]).length;
  }
  return summary;
}

/** The sandbox-relevant shape, keys and the enabled flag only. */
function summarizeSandbox(sandbox: unknown): SandboxSummary | undefined {
  if (!sandbox || typeof sandbox !== "object") return undefined;
  const s = sandbox as Record<string, unknown>;
  const summary: { enabled?: boolean; filesystem?: string[]; network?: string[] } = {};
  if (typeof s.enabled === "boolean") summary.enabled = s.enabled;
  if (s.filesystem && typeof s.filesystem === "object") summary.filesystem = Object.keys(s.filesystem as object);
  if (s.network && typeof s.network === "object") summary.network = Object.keys(s.network as object);
  return summary;
}
