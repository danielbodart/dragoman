/**
 * EXPERIMENT (not a test — run with `bun run`, iterate freely).
 *
 * How does a WebFetch(domain:x) allow behave in Codex, under MANUAL (readOnly +
 * untrusted)? A `curl x` hits two gates: the COMMAND approval (mode) and the NETWORK
 * access (allowlist). Questions:
 *   1. Does WebFetch(domain:x) → network allow make x REACHABLE?          (mapping)
 *   2. Under manual, does `curl x` still PROMPT (command gate), or does the network
 *      allow suppress it?                                                  (the crux)
 *   3. Does a Bash(curl:*) allow suppress the prompt (execpolicy)?         (compare)
 *   4. Is a non-listed host FENCED when a WebFetch allow is present?       (over-fence)
 *
 * Reads: which requestApproval methods fired (command/network), and whether curl
 * reported a reachable result (http_code!=000). Reply=accept to everything.
 *
 * Usage: bun run test/integration/webfetch.experiment.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AppServerProcess, type ServerRequest } from "../../src/codex.ts";
import { ensureCodexHome } from "../../src/codex-home.ts";
import { mirror } from "../../src/mirror.ts";
import { renderRules } from "../../src/codex-config.ts";
import { settings as mkSettings } from "./harness.ts";
import type { EffectiveSettings } from "../../src/settings.ts";
import type { ThreadStartResponse } from "../../generated/codex-protocol/ts/v2/ThreadStartResponse.ts";

interface Cell { label: string; settings: Partial<EffectiveSettings>; host: string }
const CELLS: Cell[] = [
  { label: "WebFetch allow  → curl allowed  ", settings: { sandboxEnabled: true, allow: ["WebFetch(domain:example.com)"] }, host: "example.com" },
  { label: "no rule         → curl example  ", settings: { sandboxEnabled: true }, host: "example.com" },
  { label: "Bash(curl:*)    → curl example  ", settings: { sandboxEnabled: true, allow: ["Bash(curl:*)"] }, host: "example.com" },
  { label: "WebFetch allow  → curl OTHER host", settings: { sandboxEnabled: true, allow: ["WebFetch(domain:example.com)"] }, host: "example.org" },
];

async function runOnce(cell: Cell): Promise<void> {
  const homeParent = mkdtempSync(join(homedir(), ".dragoman-webfetch-"));
  const cwd = mkdtempSync(join(homedir(), ".dragoman-cwd-"));

  const policy = mirror(mkSettings(cell.settings), "default"); // manual
  const home = ensureCodexHome(
    policy.profile ? [policy.profile] : [],
    { realHome: join(homedir(), ".codex"), isolatedHome: join(homeParent, "codex-home") },
    renderRules(policy.execpolicyAmendments, policy.denyPrefixes),
  );
  const conn = await AppServerProcess.start(["codex", "app-server"], { CODEX_HOME: home });

  const approvals: string[] = [];
  let lastMsg = "";
  let done = false;

  conn.onServerRequest(async (request: ServerRequest) => {
    if (request.method === "currentTime/read") return { currentTimeAt: Math.floor(Date.now() / 1000) };
    if (request.method.endsWith("/requestApproval")) {
      approvals.push(request.method.replace("item/", "").replace("/requestApproval", ""));
      return { decision: "accept" };
    }
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
  const base = { cwd, approvalPolicy: policy.approvalPolicy, ...reviewer, permissions: policy.profile!.id, runtimeWorkspaceRoots: [cwd] };
  const prompt =
    `Run exactly this one shell command and report its full output verbatim, then stop: ` +
    `curl -sS -m 12 -o /dev/null -w 'http=%{http_code}' https://${cell.host}`;
  const thread = (await conn.request("thread/start", base)) as ThreadStartResponse;
  await conn.request("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: prompt, text_elements: [] }], ...base });

  const deadline = Date.now() + 120_000;
  while (!done && Date.now() < deadline) await Bun.sleep(500);

  const reached = /http=(?!000)\d{3}/.test(lastMsg);
  console.log(`  ${cell.label} | approvals=[${approvals.join(",") || "none"}] | reached=${reached ? "YES" : "no "} | msg="${lastMsg.slice(-60).replace(/\s+/g, " ")}"`);

  conn.close();
  await drain.catch(() => {});
  rmSync(homeParent, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}

console.log("WebFetch/allow behaviour under manual — approvals fired + reachability\n");
for (const cell of CELLS) {
  try {
    await runOnce(cell);
  } catch (error) {
    console.log(`  ${cell.label} | ERROR: ${(error as Error).message}`);
  }
}
console.log("\n(done)");
