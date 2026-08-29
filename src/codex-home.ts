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
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hasDefaultPermissions, renderManagedBlock, spliceManagedBlock, type ManagedProfile } from "./codex-config.ts";

export interface CodexHomeLayout {
  /** The real codex home to inherit auth + config from (default `$CODEX_HOME` ?? `~/.codex`). */
  readonly realHome: string;
  /** Dragoman's isolated home (default `$DRAGOMAN_HOME` ?? `~/.dragoman` `/codex-home`). */
  readonly isolatedHome: string;
}

/** Resolve the real and isolated homes from the environment. */
export function codexHomeLayout(env: Record<string, string | undefined> = process.env): CodexHomeLayout {
  const realHome = env.CODEX_HOME ?? join(homedir(), ".codex");
  const dragomanHome = env.DRAGOMAN_HOME ?? join(homedir(), ".dragoman");
  return { realHome, isolatedHome: join(dragomanHome, "codex-home") };
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
export function ensureCodexHome(profiles: readonly ManagedProfile[], layout: CodexHomeLayout = codexHomeLayout()): string {
  const { realHome, isolatedHome } = layout;
  mkdirSync(isolatedHome, { recursive: true });
  linkFile(join(realHome, "auth.json"), join(isolatedHome, "auth.json"));

  const userConfig = readIfPresent(join(realHome, "config.toml"));
  const defaultPermissions = hasDefaultPermissions(userConfig) ? undefined : ":workspace";
  const block = renderManagedBlock(profiles, { defaultPermissions });
  writeAtomic(join(isolatedHome, "config.toml"), spliceManagedBlock(userConfig, block));

  return isolatedHome;
}

/** Point `link` at `target` via a symlink, refreshed each call so it never goes stale. */
function linkFile(target: string, link: string): void {
  rmSync(link, { force: true });
  if (existsSync(target)) symlinkSync(target, link);
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
