/**
 * Reading and merging Claude Code's settings — the "mirror Claude" half.
 *
 * Claude Code layers settings across four files (user, user-local, project,
 * project-local); reading the effective posture means merging them by Claude's
 * own rules: permission/sandbox ARRAYS union across layers, scalars are
 * last-wins by precedence. This is verified behaviour (PLAN §10), and the
 * discovery that `CLAUDE_PROJECT_DIR` is the reliable project anchor is baked in
 * here as `locateSettings`.
 *
 * The merge (`mergeSettings`) is a pure function over already-parsed layers, so
 * it is unit-tested against fixture trees with no filesystem. `readSettings` is
 * the thin IO wrapper that finds and parses the files.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The slice of Claude Code's settings Dragoman mirrors.
 *
 * Only permission/sandbox-relevant keys; everything else in settings.json
 * (theme, model, plugins…) is ignored. Shapes follow the 2.1.250 settings
 * surface (PLAN §10.1). All optional — any layer may set any subset.
 */
export interface ClaudeSettings {
  readonly permissions?: {
    readonly defaultMode?: string;
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
    readonly ask?: readonly string[];
    readonly additionalDirectories?: readonly string[];
  };
  readonly sandbox?: {
    readonly enabled?: boolean;
    readonly filesystem?: {
      readonly denyRead?: readonly string[];
      readonly denyWrite?: readonly string[];
      readonly allowRead?: readonly string[];
      readonly allowWrite?: readonly string[];
    };
    readonly network?: {
      readonly allowedDomains?: readonly string[];
      readonly deniedDomains?: readonly string[];
      readonly strictAllowlist?: boolean;
    };
  };
}

/** The effective, fully-merged posture — arrays unioned, scalars resolved. */
export interface EffectiveSettings {
  readonly defaultMode?: string;
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly ask: readonly string[];
  readonly additionalDirectories: readonly string[];
  readonly sandboxEnabled?: boolean;
  readonly denyRead: readonly string[];
  readonly denyWrite: readonly string[];
  readonly allowRead: readonly string[];
  readonly allowWrite: readonly string[];
  readonly allowedDomains: readonly string[];
  readonly deniedDomains: readonly string[];
  readonly strictAllowlist?: boolean;
}

/**
 * Merge settings layers into the effective posture.
 *
 * Layers are passed LOW→HIGH precedence (user, user-local, project,
 * project-local). Arrays union across all layers (dedup, order-preserving);
 * scalars take the highest-precedence layer that sets them — that is Claude's
 * own rule (PLAN §10.1), a union not an intersection. Pure: no IO.
 */
export function mergeSettings(layers: readonly ClaudeSettings[]): EffectiveSettings {
  const union = (pick: (s: ClaudeSettings) => readonly string[] | undefined): string[] => {
    const seen = new Set<string>();
    for (const layer of layers) for (const value of pick(layer) ?? []) seen.add(value);
    return [...seen];
  };
  // Last (highest-precedence) layer that sets the scalar wins.
  const scalar = <T>(pick: (s: ClaudeSettings) => T | undefined): T | undefined => {
    let value: T | undefined;
    for (const layer of layers) {
      const candidate = pick(layer);
      if (candidate !== undefined) value = candidate;
    }
    return value;
  };

  return {
    defaultMode: scalar((s) => s.permissions?.defaultMode),
    allow: union((s) => s.permissions?.allow),
    deny: union((s) => s.permissions?.deny),
    ask: union((s) => s.permissions?.ask),
    additionalDirectories: union((s) => s.permissions?.additionalDirectories),
    sandboxEnabled: scalar((s) => s.sandbox?.enabled),
    denyRead: union((s) => s.sandbox?.filesystem?.denyRead),
    denyWrite: union((s) => s.sandbox?.filesystem?.denyWrite),
    allowRead: union((s) => s.sandbox?.filesystem?.allowRead),
    allowWrite: union((s) => s.sandbox?.filesystem?.allowWrite),
    allowedDomains: union((s) => s.sandbox?.network?.allowedDomains),
    deniedDomains: union((s) => s.sandbox?.network?.deniedDomains),
    strictAllowlist: scalar((s) => s.sandbox?.network?.strictAllowlist),
  };
}

/** The four settings file paths, low→high precedence. */
export function locateSettings(env: Record<string, string | undefined> = process.env): string[] {
  // CLAUDE_PROJECT_DIR is the verified-reliable project anchor (PLAN §10.1);
  // cwd is only a last-ditch fallback, since it is version behaviour not a contract.
  const projectDir = env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const configDir = env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return [
    join(configDir, "settings.json"),
    join(configDir, "settings.local.json"),
    join(projectDir, ".claude", "settings.json"),
    join(projectDir, ".claude", "settings.local.json"),
  ];
}

/**
 * Read and merge the effective Claude settings from disk.
 *
 * A missing file is a normal absence (skipped), not an error — most layers are
 * absent most of the time. A present-but-unparseable file is skipped with a
 * stderr warning rather than taking the bridge down: a broken settings file
 * should degrade mirroring, not break Codex.
 */
export function readSettings(env: Record<string, string | undefined> = process.env): EffectiveSettings {
  const layers: ClaudeSettings[] = [];
  for (const path of locateSettings(env)) {
    if (!existsSync(path)) continue;
    try {
      layers.push(JSON.parse(readFileSync(path, "utf8")) as ClaudeSettings);
    } catch (error) {
      console.error(`Dragoman: ignoring unreadable settings ${path}: ${(error as Error).message}`);
    }
  }
  return mergeSettings(layers);
}
