/**
 * EXPERIMENT (not a test — run with `bun run`, iterate freely).
 *
 * Would honoring `autoAllowBashIfSandboxed=true` by switching manual's command axis
 * from `untrusted` to `on-request` (defer to the sandbox boundary) actually work —
 * WITHOUT breaking manual's "ask before edits"?
 *
 * Manual's scope is readOnly, so an EDIT always escapes it. The question: under
 * readOnly + on-request + reviewer=user, does an in-workspace edit-escape RELIABLY
 * prompt (so manual can still ask-then-write), or does on-request's model-discretion
 * make it flaky / hard-fail (breaking the contract)? And does an in-sandbox READ
 * (bash) auto-run under on-request (the autoAllow behaviour we'd be chasing)?
 *
 * Reads: edit cells want "prompted ✓" EVERY time (like untrusted does); the bash read
 * wants auto-run. If on-request makes edits flaky, keep untrusted.
 *
 * Usage: bun run test/integration/autoallow.experiment.ts
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AppServerProcess, type ServerRequest } from "../../src/codex.ts";
import { ensureCodexHome } from "../../src/codex-home.ts";
import { profileFor } from "../../src/mirror.ts";
import { settings } from "./harness.ts";
import type { AskForApproval } from "../../generated/codex-protocol/ts/v2/AskForApproval.ts";
import type { ThreadStartResponse } from "../../generated/codex-protocol/ts/v2/ThreadStartResponse.ts";

interface Cell { label: string; policy: AskForApproval; task: "edit" | "read"; repeat: number }
const CELLS: Cell[] = [
  { label: "on-request edit", policy: "on-request", task: "edit", repeat: 3 },
  { label: "untrusted  edit", policy: "untrusted", task: "edit", repeat: 2 },
  { label: "on-request read", policy: "on-request", task: "read", repeat: 1 },
];

async function runOnce(cell: Cell, n: number): Promise<void> {
  const homeParent = mkdtempSync(join(homedir(), ".dragoman-autoallow-"));
  const cwd = mkdtempSync(join(homedir(), ".dragoman-cwd-"));
  const file = join(cwd, "notes.txt");
  writeFileSync(file, "the value is OLD\n");

  // Manual's scope: the read-only profile.
  const profile = profileFor(settings({ sandboxEnabled: true }), "default")!;
  const home = ensureCodexHome([profile], { realHome: join(homedir(), ".codex"), isolatedHome: join(homeParent, "codex-home") });
  const conn = await AppServerProcess.start(["codex", "app-server"], { CODEX_HOME: home });

  let cmdReq = 0;
  let fileReq = 0;
  let done = false;

  conn.onServerRequest(async (request: ServerRequest) => {
    if (request.method === "currentTime/read") return { currentTimeAt: Math.floor(Date.now() / 1000) };
    if (request.method === "item/fileChange/requestApproval") { fileReq++; return { decision: "accept" }; }
    if (request.method.endsWith("/requestApproval")) { cmdReq++; return { decision: "accept" }; }
    throw new Error(`unhandled ${request.method}`);
  });
  const drain = (async () => {
    for await (const nt of conn.notifications) if (nt.method === "turn/completed") { done = true; break; }
  })();

  const base = { cwd, approvalPolicy: cell.policy, approvalsReviewer: "user" as const, permissions: profile.id, runtimeWorkspaceRoots: [cwd] };
  const prompt =
    cell.task === "edit"
      ? `Edit the file notes.txt in your working directory: change the word OLD to NEW. Then stop.`
      : `Run exactly this one shell command and report only its output: python3 -c "print('READVAL')" — then stop.`;
  const thread = (await conn.request("thread/start", base)) as ThreadStartResponse;
  await conn.request("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: prompt, text_elements: [] }], ...base });

  const deadline = Date.now() + 120_000;
  while (!done && Date.now() < deadline) await Bun.sleep(500);

  const prompts = cmdReq + fileReq;
  let verdict: string;
  if (cell.task === "edit") {
    const edited = readFileSync(file, "utf8").includes("NEW");
    verdict = prompts > 0 ? (edited ? "prompted → edited ✓" : "prompted → not edited") : edited ? "AUTO-EDITED (no prompt! breaks manual)" : "hard-fail (no prompt, not edited)";
  } else {
    verdict = prompts === 0 ? "auto-ran ✓" : "prompted";
  }
  console.log(`  ${cell.label} #${n} | cmdReq=${cmdReq} fileReq=${fileReq} | ${verdict}`);

  conn.close();
  await drain.catch(() => {});
  rmSync(homeParent, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}

console.log("manual (readOnly) — does on-request keep edits reliably PROMPTING? (untrusted is the baseline)\n");
for (const cell of CELLS) {
  for (let i = 1; i <= cell.repeat; i++) {
    try {
      await runOnce(cell, i);
    } catch (error) {
      console.log(`  ${cell.label} #${i} | ERROR: ${(error as Error).message}`);
    }
  }
}
console.log("\n(done)");
