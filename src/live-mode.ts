/**
 * Claude's LIVE permission mode, handed over by the PreToolUse hook.
 *
 * The server can only read the static `permissions.defaultMode` from settings, so a
 * mid-session switch (to `plan`, `acceptEdits`, …) never reaches it. A PreToolUse
 * hook DOES see the live mode (`.permission_mode` on stdin), so
 * `packaging/inject-posture.sh` writes it to a file just before each codex_run /
 * codex_continue / codex_review, and the server reads it here.
 *
 * Why a file, not the tool input: the hook used to add `posture` to the call via
 * `updatedInput`, but Claude Code's auto-mode classifier refuses to judge input a
 * hook changed, so every call in auto mode was rejected once and had to be resent.
 * The file leaves the tool input exactly as the model wrote it.
 *
 * The file is keyed by the TOOL-USE ID of that one call: the hook gets it as
 * `.tool_use_id`, and Claude Code sends the same id on the MCP request as
 * `_meta["claudecode/toolUseId"]`. Each file is read once and deleted, so a mode can
 * only ever apply to the call it was recorded for — never a stale one from earlier
 * in the session or from before a `/clear`. If there is no file (no hook ran, or no
 * id came through), the caller falls back to the static `defaultMode`. The hook
 * computes the same path; keep the two in step.
 */
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Env = Readonly<Record<string, string | undefined>>;

/** A tool-use id that is safe to use as a file name (Claude Code's are `toolu_…`). */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** The directory the hook writes to: `$XDG_RUNTIME_DIR`, else `$TMPDIR`, else /tmp. */
export function liveModeDir(env: Env = process.env): string {
  return join(env.XDG_RUNTIME_DIR || env.TMPDIR || tmpdir(), "dragoman", "live-mode");
}

/** The file for one tool call, or undefined when its id is missing or unsafe. */
export function liveModePath(toolUseId: unknown, env: Env = process.env): string | undefined {
  return typeof toolUseId === "string" && SAFE_ID.test(toolUseId) ? join(liveModeDir(env), toolUseId) : undefined;
}

/** Take (read and delete) the live mode the hook recorded for this tool call. */
export function takeLiveMode(toolUseId: unknown, env: Env = process.env): string | undefined {
  const path = liveModePath(toolUseId, env);
  if (!path) return undefined;
  let mode: string | undefined;
  try {
    mode = readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
  rmSync(path, { force: true });
  return mode;
}

/** The tool-use id Claude Code attaches to an MCP `tools/call` request, if any. */
export function toolUseIdOf(meta: unknown): string | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const id = (meta as Record<string, unknown>)["claudecode/toolUseId"];
  return typeof id === "string" ? id : undefined;
}
