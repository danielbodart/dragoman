/**
 * Shared plumbing for the live integration tests.
 *
 * These talk to a REAL `codex app-server` through Dragoman's own seams — the
 * point is to prove Codex HONOURS what `mirror()` emits, the half unit tests
 * can't reach. Two styles sit on top of this:
 *
 *  - Sandbox/network probes call `command/exec` directly (`exec`), which runs a
 *    command in the sandbox with a given `sandboxPolicy` and NO thread, turn, or
 *    model call — deterministic and free.
 *  - Approval probes wire the full `ThreadRuns` + pump stack with a
 *    `ScriptedElicitation`, and spend one real model turn to make Codex request
 *    an approval.
 *
 * Each test gets its OWN `codex app-server` via `withCodex` (fresh process, one
 * notification reader — sharing one across pumps would break that single-reader
 * invariant), and closes it in `finally`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AppServerProcess, type AppServerConn } from "../../src/codex.ts";
import { ensureCodexHome } from "../../src/codex-home.ts";
import { renderRules } from "../../src/codex-config.ts";
import { profileFor, type ClaudeMode } from "../../src/mirror.ts";
import { startPump } from "../../src/pump.ts";
import { ThreadRuns } from "../../src/thread-run.ts";
import type { Approval, ElicitationChannel } from "../../src/elicitation.ts";
import type { EffectiveSettings } from "../../src/settings.ts";
import type { RunSnapshot } from "../../src/thread-run.ts";
import type { SandboxPolicy } from "../../generated/codex-protocol/ts/v2/SandboxPolicy.ts";
import type { CommandExecResponse } from "../../generated/codex-protocol/ts/v2/CommandExecResponse.ts";

/** Run `fn` against a fresh, initialized `codex app-server`, always closing it. */
export async function withCodex<T>(fn: (conn: AppServerConn) => Promise<T>): Promise<T> {
  const conn = await AppServerProcess.start();
  try {
    return await fn(conn);
  } finally {
    conn.close();
  }
}

/** Run one command in the sandbox under `sandboxPolicy` — no thread/turn/model. */
export async function exec(
  conn: AppServerConn,
  command: readonly string[],
  cwd: string,
  sandboxPolicy: SandboxPolicy,
): Promise<CommandExecResponse> {
  return (await conn.request("command/exec", { command: [...command], cwd, sandboxPolicy })) as CommandExecResponse;
}

/**
 * Spawn codex against an isolated home carrying the ONE profile `mirror()` compiles
 * for `mode` from `effective` — the exact production provisioning (`profileFor` →
 * `ensureCodexHome([profile])`) — run `fn` with its profile id, and clean up. No
 * pre-baked pair: a scope probe provisions the scope it tests, like a real run does.
 * Model-free (`command/exec`), so deterministic and free.
 */
export async function withProfiledCodex<T>(
  effective: EffectiveSettings,
  mode: ClaudeMode,
  fn: (conn: AppServerConn, profile: string) => Promise<T>,
): Promise<T> {
  return withTempDir(async (homeParent) => {
    const profile = profileFor(effective, mode); // the single profile production would write
    const home = ensureCodexHome(profile ? [profile] : [], { realHome: join(homedir(), ".codex"), isolatedHome: join(homeParent, "codex-home") });
    const conn = await AppServerProcess.start(["codex", "app-server"], { CODEX_HOME: home });
    try {
      return await fn(conn, profile!.id);
    } finally {
      conn.close();
    }
  });
}

/**
 * A `ThreadRuns` wired EXACTLY the production way (mirrors `main.ts`): its provision
 * thunk writes only the ONE profile `mirror()` compiled for this run
 * (`policy.profile`, or none → danger-full-access) into a fresh isolated CODEX_HOME,
 * then spawns codex — so these tests exercise the live single-profile emission, not a
 * pre-baked pair. `homeParent` is a throwaway dir (from `withTempDir`).
 */
export function profiledRuns(effective: EffectiveSettings, elicitation: ScriptedElicitation, homeParent: string): ThreadRuns {
  // Mirror main.ts EXACTLY: a UNIQUE per-run home (deleted on dispose) + one shared
  // store for durable state. Sharing the store is what lets codex_continue resume a
  // thread after its run's home is gone — and using a unique home (not one shared home)
  // is what makes that a faithful test rather than a false green.
  const realHome = join(homedir(), ".codex");
  const sharedStore = join(homeParent, "shared");
  const runsRoot = join(homeParent, "runs");
  const runs: ThreadRuns = new ThreadRuns(
    async (policy) => {
      const runDir = join(runsRoot, crypto.randomUUID());
      const home = ensureCodexHome(
        policy.profile ? [policy.profile] : [],
        { realHome, isolatedHome: join(runDir, "codex-home"), sharedStore },
        renderRules(policy.execpolicyAmendments, policy.denyPrefixes),
      );
      const conn = await AppServerProcess.start(["codex", "app-server"], { CODEX_HOME: home });
      return { conn, cleanup: () => { conn.close(); rmSync(runDir, { recursive: true, force: true }); } };
    },
    (conn) => startPump(conn, runs, elicitation),
    Date.now,
    () => effective,
  );
  return runs;
}

/** Run one command under a named permission profile — no thread/turn/model. */
export async function execProfiled(
  conn: AppServerConn,
  command: readonly string[],
  cwd: string,
  profile: string,
): Promise<CommandExecResponse> {
  return (await conn.request("command/exec", { command: [...command], cwd, permissionProfile: profile })) as CommandExecResponse;
}

/**
 * An `ElicitationChannel` that records every ask and answers with a fixed
 * decision — the test's stand-in for the human. `asks` is the evidence that an
 * approval fired (or, when empty, that one did not).
 */
export class ScriptedElicitation implements ElicitationChannel {
  readonly asks: Approval[] = [];
  constructor(private readonly decision: string = "decline") {}
  async ask(approval: Approval): Promise<string> {
    this.asks.push(approval);
    return this.decision;
  }
}

/** Poll a run until it reaches a terminal state, or throw on timeout. */
export async function settle(runs: ThreadRuns, handle: string, timeoutMs = 120_000): Promise<RunSnapshot> {
  const start = Date.now();
  for (;;) {
    const snapshot = runs.status(handle);
    if (snapshot && (snapshot.status === "done" || snapshot.status === "error")) return snapshot;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`run ${handle} did not settle in ${timeoutMs}ms (status ${snapshot?.status ?? "unknown"})`);
    }
    await Bun.sleep(500);
  }
}

/** The terminal outcome text of a settled run: the last result/error event on its
 * timeline. (`settle` polls `runs.status`, which never drains, so the event is still
 * there.) Replaces the old `.result`/`.error` fields the unified event log folded in. */
export function resultText(snapshot: RunSnapshot): string {
  for (let i = snapshot.events.length - 1; i >= 0; i--) {
    const event = snapshot.events[i]!;
    if (event.kind === "result") return event.text ?? "";
    if (event.kind === "error") return event.message;
  }
  return "";
}

/** Effective settings with empty defaults, overridable field by field. */
export function settings(overrides: Partial<EffectiveSettings> = {}): EffectiveSettings {
  return {
    allow: [], deny: [], ask: [], additionalDirectories: [],
    denyRead: [], denyWrite: [], allowRead: [], allowWrite: [],
    allowedDomains: [], deniedDomains: [],
    ...overrides,
  };
}

/**
 * A throwaway directory under $HOME, passed to `fn` and removed afterwards.
 *
 * Deliberately NOT under `/tmp`: `workspace-write` keeps `/tmp` writable
 * (`excludeSlashTmp:false`), so a `/tmp` dir is inside the default writable set
 * and would make "outside the workspace" probes falsely pass. `$HOME` is outside
 * it, so a write there succeeds ONLY when the policy actually grants the path.
 */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(homedir(), ".dragoman-probe-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
