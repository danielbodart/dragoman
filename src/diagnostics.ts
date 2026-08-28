/**
 * TEMPORARY runtime probe for designing settings mirroring.
 *
 * When Claude Code launches Dragoman as a stdio MCP server, WHAT does the
 * subprocess actually see? The docs say `CLAUDE_PROJECT_DIR` is the stable
 * project root and that cwd depends on how the server is registered — but that
 * has to be checked against reality, not trusted. This tool reports the ground
 * truth from inside a real MCP invocation. Delete once mirroring is settled.
 *
 * It deliberately reports settings-file *presence* and their permission/sandbox
 * KEYS, never full file contents, so nothing sensitive lands in the transcript.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function diagnostics(): string {
  const lines: string[] = [];

  lines.push("=== Dragoman runtime diagnostics ===\n");

  lines.push("process.cwd(): " + process.cwd());
  lines.push("");

  lines.push("Claude Code env vars:");
  const interesting = [
    "CLAUDE_PROJECT_DIR",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_PLUGIN_ROOT",
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_MCP_SERVER_NAME",
    "PWD",
  ];
  for (const name of interesting) {
    lines.push(`  ${name} = ${process.env[name] ?? "(unset)"}`);
  }
  lines.push("");

  // The candidate settings roots we could mirror from.
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

  lines.push(`Resolved projectDir: ${projectDir}`);
  lines.push(`Resolved configDir:  ${configDir}`);
  lines.push("");

  lines.push("Settings files reachable (in precedence order, low→high):");
  const candidates = [
    { label: "user", path: join(configDir, "settings.json") },
    { label: "user-local", path: join(configDir, "settings.local.json") },
    { label: "project", path: join(projectDir, ".claude", "settings.json") },
    { label: "project-local", path: join(projectDir, ".claude", "settings.local.json") },
  ];
  for (const { label, path } of candidates) {
    lines.push(`  [${label}] ${path}`);
    if (!existsSync(path)) {
      lines.push("     (not present)");
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      lines.push("     present. keys: " + Object.keys(parsed).join(", "));
      lines.push("     permissions: " + summarizePermissions(parsed.permissions));
      lines.push("     sandbox: " + summarizeSandbox(parsed.sandbox));
    } catch (error) {
      lines.push("     present but unreadable: " + (error as Error).message);
    }
  }

  return lines.join("\n");
}

/** The permission-relevant shape, without echoing full rule contents. */
function summarizePermissions(permissions: unknown): string {
  if (!permissions || typeof permissions !== "object") return "(none)";
  const p = permissions as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof p.defaultMode === "string") parts.push(`defaultMode=${p.defaultMode}`);
  for (const key of ["allow", "deny", "ask", "additionalDirectories"]) {
    if (Array.isArray(p[key])) parts.push(`${key}[${(p[key] as unknown[]).length}]`);
  }
  return parts.length > 0 ? parts.join(", ") : "(present, no relevant keys)";
}

/** The sandbox-relevant shape, keys and array sizes only. */
function summarizeSandbox(sandbox: unknown): string {
  if (!sandbox || typeof sandbox !== "object") return "(none)";
  const s = sandbox as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof s.enabled === "boolean") parts.push(`enabled=${s.enabled}`);
  if (s.filesystem && typeof s.filesystem === "object") {
    parts.push("filesystem={" + Object.keys(s.filesystem as object).join(",") + "}");
  }
  if (s.network && typeof s.network === "object") {
    parts.push("network={" + Object.keys(s.network as object).join(",") + "}");
  }
  return parts.length > 0 ? parts.join(", ") : "(present, no relevant keys)";
}
