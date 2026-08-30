/**
 * EXPERIMENT (not a test — run with `bun run`, iterate freely).
 *
 * Does a `rules/dragoman.rules` execpolicy file in the isolated CODEX_HOME BIND
 * during a run — the config-layer enforcement for Claude's allow/deny Bash rules?
 *
 *   A. allow skips the prompt under `untrusted` (manual): with an `allow` prefix_rule
 *      for `python3`, a non-trusted READ (`python3 -c print(SECRET)`) runs with NO
 *      client approval and reports the value — the override the user described.
 *   B. baseline (no rule): the same command under manual DOES prompt (cmdReq>0) —
 *      proving A is the rule's doing.
 *   C. forbidden blocks under `never` (bypass): a `forbidden` prefix_rule stops a
 *      `touch` even with approvalPolicy=never + dangerFullAccess — the enforcement the
 *      approval round-trip can't reach today (finding [B]).
 *
 * Usage: bun run test/integration/execpolicy-bind.experiment.ts
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { AppServerProcess, type ServerRequest } from "../../src/codex.ts";
import { ensureCodexHome } from "../../src/codex-home.ts";
import { mirror, type ClaudeMode } from "../../src/mirror.ts";
import { settings } from "./harness.ts";
import type { ThreadStartResponse } from "../../generated/codex-protocol/ts/v2/ThreadStartResponse.ts";

const SECRET = "PLUM-8842";

interface Cell {
  label: string;
  mode: ClaudeMode;
  rules: string;
  check: "reported" | "notwrote";
  expectPrompt: "yes" | "no";
}

const ALLOW_PY = `prefix_rule(pattern=["python3"], decision="allow")\n`;
const FORBID_TOUCH = `prefix_rule(pattern=["touch"], decision="forbidden", justification="Claude deny rule")\n`;

const CELLS: Cell[] = [
  { label: "A allow   manual  ", mode: "default", rules: ALLOW_PY, check: "reported", expectPrompt: "no" },
  { label: "B norule  manual  ", mode: "default", rules: "", check: "reported", expectPrompt: "yes" },
  { label: "C forbid  bypass  ", mode: "bypassPermissions", rules: FORBID_TOUCH, check: "notwrote", expectPrompt: "no" },
];

async function runOnce(cell: Cell): Promise<void> {
  const homeParent = mkdtempSync(join(homedir(), ".dragoman-execpol-"));
  const cwd = mkdtempSync(join(homedir(), ".dragoman-cwd-"));
  const target = join(cwd, "made.txt");
  rmSync(target, { force: true });

  const policy = mirror(settings({ sandboxEnabled: true }), cell.mode);
  const home = ensureCodexHome(policy.profile ? [policy.profile] : [], {
    realHome: join(homedir(), ".codex"),
    isolatedHome: join(homeParent, "codex-home"),
  });
  mkdirSync(join(home, "rules"), { recursive: true });
  writeFileSync(join(home, "rules", "dragoman.rules"), cell.rules);

  const conn = await AppServerProcess.start(["codex", "app-server"], { CODEX_HOME: home });
  let cmdReq = 0;
  let lastMsg = "";
  let done = false;

  conn.onServerRequest(async (request: ServerRequest) => {
    if (request.method === "currentTime/read") return { currentTimeAt: Math.floor(Date.now() / 1000) };
    if (request.method.endsWith("/requestApproval")) { cmdReq++; return { decision: "accept" }; }
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

  const reviewer = policy.approvalsReviewer ? { approvalsReviewer: policy.approvalsReviewer } : {};
  const base = policy.profile
    ? { cwd, approvalPolicy: policy.approvalPolicy, ...reviewer, permissions: policy.profile.id, runtimeWorkspaceRoots: [cwd] }
    : { cwd, approvalPolicy: policy.approvalPolicy, ...reviewer, sandbox: "danger-full-access" as const };
  const prompt =
    cell.check === "reported"
      ? `Run exactly this one shell command and report only its output: python3 -c "print('${SECRET}')" — then stop.`
      : `Run exactly this one shell command, then stop: touch ${target}`;
  const thread = (await conn.request("thread/start", base)) as ThreadStartResponse;
  await conn.request("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: prompt, text_elements: [] }], ...base });

  const deadline = Date.now() + 120_000;
  while (!done && Date.now() < deadline) await Bun.sleep(500);

  const promptedOk = (cmdReq > 0 ? "yes" : "no") === cell.expectPrompt;
  let outcome: string;
  if (cell.check === "reported") {
    const reported = lastMsg.includes(SECRET);
    outcome = `reported=${reported ? "YES" : "no "}`;
  } else {
    const wrote = existsSync(target);
    outcome = `wrote=${wrote ? "YES(leak!)" : "no(blocked)"}`;
  }
  console.log(`  ${cell.label} | ${outcome} | cmdReq=${cmdReq}(want ${cell.expectPrompt}) ${promptedOk ? "✓" : "✗"} | msg="${lastMsg.slice(-70).replace(/\s+/g, " ")}"`);

  conn.close();
  await drain.catch(() => {});
  rmSync(homeParent, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}

console.log("bind check — A: allow→no prompt+reported; B: no rule→prompts; C: forbidden→no write under never\n");
for (const cell of CELLS) {
  try {
    await runOnce(cell);
  } catch (error) {
    console.log(`  ${cell.label} | ERROR: ${(error as Error).message}`);
  }
}
console.log("\n(done)");
