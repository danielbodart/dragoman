/**
 * Dragoman's runtime observability probe — a permanent operator tool.
 *
 * It answers, from inside a real MCP invocation, two questions no log line
 * outside the subprocess can: WHAT does the bridge actually see (cwd, which
 * `CLAUDE_*` env, which settings files are reachable, and what those settings
 * would mirror onto Codex for each posture), and WHAT is it doing right now
 * (the live runs, their status, active turn, and latest milestone). The first
 * half diagnoses a mirror that fired wrong; the second diagnoses a run that is
 * stuck, waiting, or unaccounted for. As the tool surface grows past
 * `codex_run`/`codex_status`, this stays the single ground-truth view.
 *
 * It deliberately reports settings-file *presence* and their permission/sandbox
 * KEYS, never full file contents, so nothing sensitive lands in the transcript.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { mirror, resolveMode } from "./mirror.ts";
import { readSettings } from "./settings.ts";
import type { ThreadRuns } from "./thread-run.ts";
import type { RunEvent } from "./model.ts";
import { version } from "./version.ts";

/**
 * Render the probe. `runs` is optional so the pure env/mirror halves still work
 * without a registry (e.g. a smoke test); when present, the live-runs section is
 * appended so an operator can see every in-flight Codex run and its active turn.
 */
export function diagnostics(runs?: ThreadRuns): string {
  const lines: string[] = [];

  lines.push(`=== Dragoman ${version} runtime diagnostics ===\n`);

  lines.push(activeRuns(runs));
  lines.push("");

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

  // The live end-to-end result: what Dragoman would actually mirror onto Codex
  // right now, for each posture. This is the settings-mirror pipeline (PLAN §10)
  // exercised against the real merged settings.
  lines.push("");
  lines.push("=== Mirror preview (effective settings → Codex policy) ===");
  const settings = readSettings(process.env);
  lines.push("effective: " + JSON.stringify({
    defaultMode: settings.defaultMode,
    allow: settings.allow.length,
    deny: settings.deny.length,
    additionalDirectories: settings.additionalDirectories,
    sandboxEnabled: settings.sandboxEnabled,
    allowedDomains: settings.allowedDomains.length,
  }));
  for (const posture of [undefined, "plan", "bypassPermissions"]) {
    const mode = resolveMode(settings, posture);
    const policy = mirror(settings, mode);
    lines.push(`  posture=${posture ?? "(none→static)"} → mode=${mode}:`);
    lines.push(`     approvalPolicy=${JSON.stringify(policy.approvalPolicy)}  profile=${JSON.stringify(policy.profile)}`);
    if (policy.execpolicyAmendments.length > 0) {
      lines.push(`     execpolicyAmendments=${JSON.stringify(policy.execpolicyAmendments)}`);
    }
  }

  return lines.join("\n");
}

/**
 * The live-runs section: every in-flight (and recently-settled) run the registry
 * still holds, with the two identifiers a cancel/steer/continue needs (handle =
 * thread id, plus the active turn id) and the newest milestone. This is the
 * operational half — "is anything stuck / waiting / unaccounted for right now" —
 * that the env/mirror halves can't show. No registry (pure call) → say so.
 */
function activeRuns(runs?: ThreadRuns): string {
  if (!runs) return "Active runs: (registry not wired)";
  const handles = runs.handles();
  if (handles.length === 0) return "Active runs: none";

  const lines = [`Active runs (${handles.length}):`];
  for (const handle of handles) {
    const run = runs.status(handle);
    if (!run) continue;
    const turn = run.turnId ? ` turn=${run.turnId}` : " turn=(none yet)";
    // The last undrained event, if any — a poll may have already drained the log,
    // so this is best-effort colour on top of the authoritative `status`.
    const last = run.events.at(-1);
    const beat = last ? ` — ${eventLabel(last)}` : "";
    const ctx = run.ctx !== undefined ? ` ctx=${run.ctx}%` : "";
    lines.push(`  [${run.status}] ${handle}${turn}${ctx}${beat}`);
  }
  return lines.join("\n");
}

/** A short operator-facing label for one structured event — the diagnostics dump
 * is human text, so it renders the timeline's last event to a one-liner here (the
 * MCP tools return the events structured; this is only the debug view). */
function eventLabel(event: RunEvent): string {
  switch (event.kind) {
    case "command":
      return `${event.phase}: ${event.command}`;
    case "edit":
      return `edited ${event.files.map((f) => f.path).join(", ")}`;
    case "webSearch":
      return `web search${event.query ? `: ${event.query}` : ""}`;
    case "mcpTool":
      return `${event.server}.${event.tool} (${event.status})`;
    case "plan":
      return `plan: ${event.text}`;
    case "autoApproval":
      return `${event.decision}: ${event.action}`;
    case "approval":
      return event.phase === "waiting" ? `awaiting approval: ${event.what}` : `${event.decision} ${event.what}`;
    case "message":
      return event.text;
    case "result":
      return `result (${event.status})`;
    case "error":
      return `error: ${event.message}`;
  }
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
