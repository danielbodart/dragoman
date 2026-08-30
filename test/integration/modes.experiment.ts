/**
 * EXPERIMENT (not a test — run with `bun run`, iterate freely).
 *
 * Probe the NON-`auto` modes the policy doc maps from docs-only, to settle the
 * open unknowns before re-doing the mode mapping:
 *
 *   1. Manual/default (readOnly + untrusted + reviewer=user): does an IN-WORKSPACE
 *      write ESCALATE to the client (so Manual can "ask then write") or hard-fail
 *      (so Manual == plan, can never write)?  Probed twice: reply accept vs decline.
 *   2. acceptEdits (workspace + untrusted): does an in-workspace write AUTO-run
 *      (no client approval)?  And does an ESCAPE (write outside workspace) escalate?
 *   3. Native Codex plan mode (collaborationMode {mode:"plan"}): asked to write,
 *      does it refuse / produce a plan instead of writing — even with a writable
 *      workspace sandbox under it?
 *
 * Reads: escape/wrote = did the target file appear; cmdReq/fileReq = client approval
 * requests by channel; review = auto-review decisionSource/status if any; msg = tail
 * of the model's final message.
 *
 * Usage: bun run test/integration/modes.experiment.ts
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AppServerProcess, type ServerRequest } from "../../src/codex.ts";
import { ensureCodexHome } from "../../src/codex-home.ts";
import { allProfiles } from "../../src/mirror.ts";
import { settings } from "./harness.ts";
import type { AskForApproval } from "../../generated/codex-protocol/ts/v2/AskForApproval.ts";
import type { ApprovalsReviewer } from "../../generated/codex-protocol/ts/v2/ApprovalsReviewer.ts";

const MODEL = "gpt-5.6-terra";

interface Cell {
  label: string;
  profile: "dragoman-read-only" | "dragoman-workspace";
  approvalPolicy: AskForApproval;
  reviewer: ApprovalsReviewer;
  /** What we reply to any client approval request. */
  reply: "accept" | "decline";
  /** true → set collaborationMode {mode:"plan"} on the turn (native plan mode). */
  plan?: boolean;
  /** "in" → write inside cwd; "out" → write to /home/dan (outside workspace). */
  where: "in" | "out";
}

const CELLS: Cell[] = [
  { label: "manual  in-ws  accept ", profile: "dragoman-read-only", approvalPolicy: "untrusted", reviewer: "user", reply: "accept", where: "in" },
  { label: "manual  in-ws  decline", profile: "dragoman-read-only", approvalPolicy: "untrusted", reviewer: "user", reply: "decline", where: "in" },
  { label: "accept  in-ws  accept ", profile: "dragoman-workspace", approvalPolicy: "untrusted", reviewer: "user", reply: "accept", where: "in" },
  { label: "accept  escape accept ", profile: "dragoman-workspace", approvalPolicy: "untrusted", reviewer: "user", reply: "accept", where: "out" },
  { label: "plan    in-ws  accept ", profile: "dragoman-workspace", approvalPolicy: "untrusted", reviewer: "user", reply: "accept", where: "in", plan: true },
];

function promptFor(target: string): string {
  return (
    `Using your tools, attempt exactly one action: create a file at ${target} containing ` +
    `the single word "ok". Then report the exact outcome (created, or the exact error/refusal) ` +
    `and stop. Do nothing else.`
  );
}

async function runOnce(cell: Cell): Promise<void> {
  const homeParent = mkdtempSync(join(homedir(), ".dragoman-modes-"));
  const cwd = mkdtempSync(join(homedir(), ".dragoman-cwd-"));
  const target = cell.where === "in" ? join(cwd, "probe.txt") : join(homedir(), "dragoman-escape-probe.txt");
  rmSync(target, { force: true });

  const home = ensureCodexHome(allProfiles(settings({ sandboxEnabled: true })), {
    realHome: join(homedir(), ".codex"),
    isolatedHome: join(homeParent, "codex-home"),
  });
  const conn = await AppServerProcess.start(["codex", "app-server"], { CODEX_HOME: home });

  let cmdReq = 0;
  let fileReq = 0;
  let decisionSource = "-";
  let status = "-";
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
      if (nt.method === "item/autoApprovalReview/completed") {
        const r = nt.params as { decisionSource?: string; review?: { status?: string } };
        decisionSource = r.decisionSource ?? decisionSource;
        status = r.review?.status ?? status;
      }
      // Best-effort capture of the assistant's text for the final message.
      const p = nt.params as Record<string, unknown> | undefined;
      const text = extractText(p);
      if (text) lastMsg = text;
      if (nt.method === "turn/completed") { done = true; break; }
    }
  })();

  const collab = cell.plan
    ? { collaborationMode: { mode: "plan" as const, settings: { model: MODEL, reasoning_effort: null, developer_instructions: null } } }
    : {};

  const thread = (await conn.request("thread/start", {
    cwd,
    approvalPolicy: cell.approvalPolicy,
    approvalsReviewer: cell.reviewer,
    permissions: cell.profile,
    runtimeWorkspaceRoots: [cwd],
  })) as { thread: { id: string } };

  await conn.request("turn/start", {
    threadId: thread.thread.id,
    input: [{ type: "text", text: promptFor(target), text_elements: [] }],
    approvalPolicy: cell.approvalPolicy,
    approvalsReviewer: cell.reviewer,
    permissions: cell.profile,
    runtimeWorkspaceRoots: [cwd],
    ...collab,
  });

  const deadline = Date.now() + 120_000;
  while (!done && Date.now() < deadline) await Bun.sleep(500);

  const wrote = existsSync(target);
  const review = decisionSource === "-" && status === "-" ? "(none)" : `${decisionSource}/${status}`;
  console.log(
    `  ${cell.label} | wrote=${wrote ? "YES" : "no "} | cmdReq=${cmdReq} fileReq=${fileReq} | review=${review} | msg="${lastMsg.slice(-90).replace(/\s+/g, " ")}"`,
  );

  conn.close();
  await drain.catch(() => {});
  rmSync(homeParent, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
  rmSync(target, { force: true });
}

/** Pull assistant text out of whatever notification shape carries it. */
function extractText(p: Record<string, unknown> | undefined): string | undefined {
  if (!p) return undefined;
  if (typeof p.text === "string") return p.text;
  const item = p.item as Record<string, unknown> | undefined;
  if (item && typeof item.text === "string") return item.text;
  if (item && Array.isArray(item.content)) {
    const parts = (item.content as Array<{ text?: string }>).map((c) => c.text).filter(Boolean);
    if (parts.length) return parts.join(" ");
  }
  return undefined;
}

console.log("legend: wrote = target file appeared; cmdReq/fileReq = client approvals by channel; review = autoReview; msg = model's final words\n");
for (const cell of CELLS) {
  try {
    await runOnce(cell);
  } catch (error) {
    console.log(`  ${cell.label} | ERROR: ${(error as Error).message}`);
  }
}
console.log("\n(done)");
