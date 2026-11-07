// Parity, TypeScript side: `start TOKEN CWD` starts a thread the production
// way (per-run home, the shared store under $DRAGOMAN_HOME) asking Codex to
// remember TOKEN, and prints the thread id; `resume ID CWD` resumes a thread
// from the shared store and asks for the token back, printing the answer.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { AppServerProcess } from "../src/codex.ts";
import { codexHomeLayout, ensureCodexHome } from "../src/codex-home.ts";
import { renderRules } from "../src/codex-config.ts";
import { startPump } from "../src/pump.ts";
import { ThreadRuns } from "../src/thread-run.ts";

const [mode, arg, cwd] = process.argv.slice(2);
const command = (process.env.DRAGOMAN_CODEX_COMMAND ?? "codex app-server").split(" ");
const { realHome, sharedStore } = codexHomeLayout();
const dragomanHome = process.env.DRAGOMAN_HOME!;
const empty = { allow: [], deny: [], ask: [], additionalDirectories: [], denyRead: [], denyWrite: [], allowRead: [], allowWrite: [], allowedDomains: [], deniedDomains: [] };

if (mode === "start") {
  const runs: ThreadRuns = new ThreadRuns(
    async (policy) => {
      const runDir = join(dragomanHome, "runs", crypto.randomUUID());
      const home = ensureCodexHome(policy.profile ? [policy.profile] : [], { realHome, isolatedHome: join(runDir, "codex-home"), sharedStore }, renderRules(policy.execpolicyAmendments, policy.denyPrefixes));
      const conn = await AppServerProcess.start(command, { CODEX_HOME: home });
      return { conn, cleanup: () => { conn.close(); rmSync(runDir, { recursive: true, force: true }); } };
    },
    (conn) => { void startPump(conn, runs, { ask: async () => "decline" }); },
    Date.now,
    () => empty,
  );
  const handle = await runs.start(`Remember this exact token: ${arg}. Reply with only the word ok.`, cwd!, "default");
  for (;;) {
    const s = runs.status(handle);
    if (s?.status === "done" || s?.status === "error") break;
    await Bun.sleep(500);
  }
  console.log(handle);
  runs.closeAll();
  process.exit(0);
} else {
  const home = ensureCodexHome([], { realHome, isolatedHome: join(dragomanHome, "runs", "resume-ts", "codex-home"), sharedStore });
  const conn = await AppServerProcess.start(command, { CODEX_HOME: home });
  await conn.request("thread/resume", { threadId: arg!, cwd: cwd!, approvalPolicy: "untrusted", sandbox: "read-only" } as never);
  await conn.request("turn/start", { threadId: arg!, input: [{ type: "text", text: "What exact token did I ask you to remember earlier? Reply with only that token.", text_elements: [] }] } as never);
  for await (const n of conn.notifications) {
    if (n.method === "turn/completed") {
      const items = (n.params as { turn: { items: { type: string; text?: string }[] } }).turn.items;
      console.log(items.filter((i) => i.type === "agentMessage").at(-1)?.text ?? "");
      break;
    }
  }
  conn.close();
  process.exit(0);
}
