/**
 * Dragoman's isolated `CODEX_HOME`.
 *
 * Per-host network filtering needs a Codex permission profile + the network
 * proxy, and both live in `config.toml`. Writing them into the user's real
 * `~/.codex/config.toml` would leak: any `[permissions]` profile there forces a
 * global `default_permissions`, and `features.network_proxy` would route ALL the
 * user's codex traffic through the proxy — changing how their non-Dragoman codex
 * usage behaves. So Dragoman spawns `codex app-server` with `CODEX_HOME` pointed
 * at its OWN home, whose `config.toml` is the user's config verbatim PLUS the
 * managed block, and whose `auth.json` is a symlink to the user's — real auth,
 * isolated config, zero leak.
 *
 * IO lives here; the block rendering it composes is the pure `codex-config`.
 *
 * ## Isolated config, SHARED state
 *
 * The per-run home isolates only what MUST be per-run: `config.toml` (the managed
 * profile + the global `network_proxy` flag) and `rules/` (Claude's live allow/deny
 * as execpolicy — auto-discovered globally per home, so it can't be shared). Both are
 * filesystem-level and differ per run, which is why the home is per-run at all.
 *
 * Everything ELSE has no reason to be isolated and every reason to persist — but it
 * splits by what it IS:
 *
 *  - **Thread state** (`sessions/` + `session_index.jsonl`) — the rollout. If it dies
 *    with the run's home, `thread/resume` (codex_continue) can't find it (verified: a
 *    fresh home gives `-32600: no rollout found`). Symlinked into each home from a
 *    Dragoman-owned store (`~/.dragoman/shared`), NOT the real codex home — so Dragoman
 *    never writes history into the user's `~/.codex` (containment) and its threads don't
 *    pollute their `codex resume` list.
 *  - **Caches** (`cache/` + `models_cache.json`) — pure perf, regenerable. Symlinked to
 *    the REAL codex home so a Dragoman run reuses the user's already-warm model cache
 *    instead of a cold Dragoman-private one. Low-stakes, so performance wins over
 *    containment here.
 *
 * `auth.json` already makes the same move to the real home. The volatile sqlite state
 * and lock dirs are deliberately NOT shared at all — concurrent per-run processes
 * writing shared sqlite would risk corruption, and resume rebuilds from the rollout.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { renderManagedBlock, spliceManagedBlock, withDefaultPermissions, type ManagedProfile } from "./codex-config.ts";

/** Thread state → the Dragoman-owned shared store (contained; the rollout resume needs). */
const STATE_DIRS = ["sessions"] as const;
const STATE_FILES = ["session_index.jsonl"] as const;
/** Caches → the REAL codex home (warm, regenerable; perf beats containment here). */
const CACHE_DIRS = ["cache"] as const;
const CACHE_FILES = ["models_cache.json"] as const;

export interface CodexHomeLayout {
  /** The real codex home to inherit auth + config from (default `$CODEX_HOME` ?? `~/.codex`). */
  readonly realHome: string;
  /** Dragoman's isolated home (default `$DRAGOMAN_HOME` ?? `~/.dragoman` `/codex-home`). */
  readonly isolatedHome: string;
  /** Dragoman-owned store for the thread rollout (`sessions/` + index), symlinked into
   * every home so a thread outlives its run's ephemeral home. Caches share the REAL home
   * instead (see `shareState`). Omit to skip state-sharing (config-only tests that never
   * resume). Default `~/.dragoman/shared`. */
  readonly sharedStore?: string;
}

/** Resolve the real, isolated, and shared-store paths from the environment. */
export function codexHomeLayout(env: Record<string, string | undefined> = process.env): CodexHomeLayout {
  const realHome = env.CODEX_HOME ?? join(homedir(), ".codex");
  const dragomanHome = env.DRAGOMAN_HOME ?? join(homedir(), ".dragoman");
  return { realHome, isolatedHome: join(dragomanHome, "codex-home"), sharedStore: join(dragomanHome, "shared") };
}

/**
 * Build/refresh the isolated home and return its path (to set as `CODEX_HOME`
 * when spawning codex). Inherits the user's auth via a symlink and their config
 * verbatim, splicing in Dragoman's managed profile block. Idempotent: safe to
 * call before every spawn.
 *
 * `default_permissions` is emitted only when the user's own config doesn't set
 * one (Codex requires it once any `[permissions]` profile exists); we default it
 * to `:workspace` to preserve Codex's normal posture, and otherwise respect the
 * value the user already carries in their config.
 */
export function ensureCodexHome(
  profiles: readonly ManagedProfile[],
  layout: CodexHomeLayout = codexHomeLayout(),
  rules = "",
): string {
  const { realHome, isolatedHome, sharedStore } = layout;
  mkdirSync(isolatedHome, { recursive: true });
  linkFile(join(realHome, "auth.json"), join(isolatedHome, "auth.json"));
  // Durable state (the rollout) is symlinked in from the shared store so a thread
  // survives this home's teardown and any later run/continuation can resume it; caches
  // are symlinked to the real home for a warm start.
  if (sharedStore) shareState(isolatedHome, sharedStore, realHome);

  const userConfig = readIfPresent(join(realHome, "config.toml"));
  const spliced = spliceManagedBlock(userConfig, renderManagedBlock(profiles));
  // default_permissions is only needed (and only valid) once a [permissions]
  // profile exists — i.e. when there are domain rules. `:workspace` preserves
  // Codex's normal posture; a user's own value is kept.
  const config = profiles.length > 0 ? withDefaultPermissions(spliced, ":workspace") : spliced;
  writeAtomic(join(isolatedHome, "config.toml"), config);

  // Claude's allow/deny Bash rules as an execpolicy file, where Codex auto-discovers
  // it (`CODEX_HOME/rules/*.rules`). This is the config-layer enforcement that binds
  // for every command, independent of the approval round-trip. Empty ⇒ no file.
  if (rules !== "") {
    mkdirSync(join(isolatedHome, "rules"), { recursive: true });
    writeAtomic(join(isolatedHome, "rules", "dragoman.rules"), rules);
  }

  return isolatedHome;
}

/** Point `link` at `target` via a symlink, refreshed each call so it never goes stale. */
function linkFile(target: string, link: string): void {
  rmSync(link, { force: true });
  if (existsSync(target)) symlinkSync(target, link);
}

/**
 * Symlink the durable/shareable state into this home so it outlives the home: the
 * thread rollout to the Dragoman-owned `store`, the caches to the real codex `home`.
 * DIRS are pre-created (codex writes files into them through the link); FILES are linked
 * even when absent — a dangling symlink resolves on codex's first write. Cache-sharing is
 * skipped when the real home is absent (a machine without codex — nothing to warm from).
 * Idempotent (relinked each call).
 */
function shareState(isolatedHome: string, store: string, realHome: string): void {
  linkGroup(isolatedHome, store, STATE_DIRS, STATE_FILES);
  if (existsSync(realHome)) linkGroup(isolatedHome, realHome, CACHE_DIRS, CACHE_FILES);
}

/** Symlink a group of dirs + files from `target` root into `home`, creating the target
 * dirs (files may be dangling until codex first writes them). */
function linkGroup(home: string, target: string, dirs: readonly string[], files: readonly string[]): void {
  for (const name of dirs) mkdirSync(join(target, name), { recursive: true });
  for (const name of [...dirs, ...files]) linkInto(join(target, name), join(home, name));
}

/** Replace whatever is at `link` (a stale symlink, or a real dir/file codex created) with
 * a fresh symlink to `target` — `target` need not exist yet (dangling links are fine). */
function linkInto(target: string, link: string): void {
  rmSync(link, { recursive: true, force: true });
  symlinkSync(target, link);
}

function readIfPresent(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** Write via a temp file + rename, so a concurrent reader never sees a half-written config. */
function writeAtomic(path: string, content: string): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}
