/**
 * EXPERIMENT (not a test — run with `bun run`, iterate freely).
 *
 * End-to-end verification of the CORRECTED mode mapping, driving codex exactly as
 * thread-run.ts does but building the policy from the real `mirror()` — so it proves
 * the wiring, not just hand-set knobs:
 *
 *   - plan       → native plan mode (settings.model filled from thread response):
 *                  model REFUSES to write, no approval, no file.
 *   - acceptEdits→ granular: in-ws edit AUTO-runs (0 approvals); escape PROMPTS.
 *   - manual     → in-ws edit PROMPTS (fileChange), accept → written.
 *
 * Usage: bun run test/integration/mapping-verify.experiment.ts
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AppServerProcess, type ServerRequest } from "../../src/codex.ts";
import { ensureCodexHome } from "../../src/codex-home.ts";
import { allProfiles, mirror, type ClaudeMode } from "../../src/mirror.ts";
import { settings } from "./harness.ts";
import type { ThreadStartResponse } from "../../generated/codex-protocol/ts/v2/ThreadStartResponse.ts";

interface Cell { mode: ClaudeMode; where: "in" | "out"; reply: "accept" | "decline"; expect: string }
const CELLS: Cell[] = [
  { mode: "plan", where: "in", reply: "accept", expect: "no write, model refuses (native plan)" },
  { mode: "acceptEdits", where: "in", reply: "accept", expect: "auto-run, 0 approvals" },
  { mode: "acceptEdits", where: "out", reply: "accept", expect: "escape prompts" },
  { mode: "manual", where: "in", reply: "accept", expect: "in-ws edit prompts, accept writes" },
];

function promptFor(target: string): string {
  return (
    `Using your tools, attempt exactly one action: create a file at ${target} containing ` +
    `the single word "ok". Then report the exact outcome (created, or the exact error/refusal) ` +
    `and stop. Do nothing else.`
  );
}

async function runOnce(cell: Cell): Promise<void> {
  const homeParent = mkdtempSync(join(homedir(), ".dragoman-verify-"));
  const cwd = mkdtempSync(join(homedir(), ".dragoman-cwd-"));
  const target = cell.where === "in" ? join(cwd, "probe.txt") : join(homedir(), "dragoman-escape-probe.txt");
  rmSync(target, { force: true });

  // The REAL compiled policy for this mode.
  const policy = mirror(settings({ sandboxEnabled: true }), cell.mode);
  const home = ensureCodexHome(allProfiles(settings({ sandboxEnabled: true })), {
    realHome: join(homedir(), ".codex"),
    isolatedHome: join(homeParent, "codex-home"),
  });
  const conn = await AppServerProcess.start(["codex", "app-server"], { CODEX_HOME: home });

  let cmdReq = 0;
  let fileReq = 0;
  let lastMsg = "";
  let done = false;

  conn.onServerRequest(async (request: ServerRequest) => {
    if (request.method === "currentTime/read") return { currentTimeAt: Math.floor(Date.now() / 1000) };
    if (request.method === "item/commandExecution/requestApproval") { cmdReq++; return { decision: cell.reply }; }
    if (request.method === "item/fileChange/requestApproval") { fileReq++; return { decision: cell.reply }; }
    if (request.method.endsWith("/requestApproval")) { cmdReq++; return { decision: cell.reply }; }
    throw new Error(`unhandled ${request.method}`);
  });

  const drain = (async () => {
    for await (const nt of conn.notifications) {
      const p = nt.params as Record<string, unknown> | undefined;
      const item = p?.item as Record<string, unknown> | undefined;
      if (typeof p?.text === "string") lastMsg = p.text;
      else if (item && typeof item.text === "string") lastMsg = item.text;
      if (nt.method === "turn/completed") { done = true; break; }
    }
  })();

  // Mirror thread-run.ts exactly: profile → permissions + runtimeWorkspaceRoots.
  const reviewer = policy.approvalsReviewer ? { approvalsReviewer: policy.approvalsReviewer } : {};
  const startParams = policy.profile
    ? { cwd, approvalPolicy: policy.approvalPolicy, ...reviewer, permissions: policy.profile.id, runtimeWorkspaceRoots: [cwd] }
    : { cwd, approvalPolicy: policy.approvalPolicy, ...reviewer, sandbox: "danger-full-access" as const };
  const thread = (await conn.request("thread/start", startParams)) as ThreadStartResponse;

  // Native plan mode: fill settings.model from the resolved thread, as thread-run does.
  const collaborationMode = policy.collaborationMode
    ? {
        collaborationMode: {
          mode: policy.collaborationMode,
          settings: { model: thread.model, reasoning_effort: thread.reasoningEffort, developer_instructions: null },
        },
      }
    : {};

  await conn.request("turn/start", {
    threadId: thread.thread.id,
    input: [{ type: "text", text: promptFor(target), text_elements: [] }],
    approvalPolicy: policy.approvalPolicy,
    ...reviewer,
    ...(policy.profile ? { permissions: policy.profile.id } : {}),
    ...collaborationMode,
  });

  const deadline = Date.now() + 120_000;
  while (!done && Date.now() < deadline) await Bun.sleep(500);

  const wrote = existsSync(target);
  const tag = `${cell.mode.padEnd(11)} ${cell.where === "in" ? "in-ws " : "escape"}`;
  console.log(
    `  ${tag} | wrote=${wrote ? "YES" : "no "} | cmdReq=${cmdReq} fileReq=${fileReq} | expect: ${cell.expect} | msg="${lastMsg.slice(-70).replace(/\s+/g, " ")}"`,
  );

  conn.close();
  await drain.catch(() => {});
  rmSync(homeParent, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
  rmSync(target, { force: true });
}

console.log("verifying corrected mapping end-to-end via mirror()\n");
for (const cell of CELLS) {
  try {
    await runOnce(cell);
  } catch (error) {
    console.log(`  ${cell.mode} ${cell.where} | ERROR: ${(error as Error).message}`);
  }
}
console.log("\n(done)");
