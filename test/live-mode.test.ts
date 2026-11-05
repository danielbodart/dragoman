import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveModeDir, liveModePath, takeLiveMode, toolUseIdOf } from "../src/live-mode.ts";

const CALL = "toolu_01ABCdef234";
const HOOK = join(import.meta.dir, "..", "packaging", "inject-posture.sh");

let runtime: string;
let env: Record<string, string>;
beforeEach(() => {
  runtime = mkdtempSync(join(tmpdir(), "dragoman-live-mode-"));
  env = { XDG_RUNTIME_DIR: runtime };
});
afterEach(() => { rmSync(runtime, { recursive: true, force: true }); });

/** Run the hook with `input` on stdin, the runtime dir pointed at our temp dir. */
function runHook(input: object): { stdout: string; exitCode: number } {
  const proc = Bun.spawnSync(["bash", HOOK], {
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    env: { ...process.env, XDG_RUNTIME_DIR: runtime },
  });
  return { stdout: proc.stdout.toString(), exitCode: proc.exitCode };
}

describe("takeLiveMode", () => {
  test("reads the mode recorded for this call, then deletes it", () => {
    mkdirSync(liveModeDir(env), { recursive: true });
    writeFileSync(join(liveModeDir(env), CALL), "plan\n");
    expect(takeLiveMode(CALL, env)).toBe("plan");
    expect(takeLiveMode(CALL, env)).toBeUndefined(); // consumed: it can never apply twice
  });

  test("ignores another call's file", () => {
    mkdirSync(liveModeDir(env), { recursive: true });
    writeFileSync(join(liveModeDir(env), "toolu_earlier"), "bypassPermissions\n");
    expect(takeLiveMode(CALL, env)).toBeUndefined();
  });

  test("is undefined without a tool-use id, or with one unsafe as a file name", () => {
    expect(takeLiveMode(undefined, env)).toBeUndefined();
    expect(liveModePath("../etc", env)).toBeUndefined();
  });

  test("falls back to TMPDIR when XDG_RUNTIME_DIR is unset", () => {
    expect(liveModeDir({ TMPDIR: runtime })).toBe(join(runtime, "dragoman", "live-mode"));
  });
});

describe("toolUseIdOf", () => {
  test("reads Claude Code's tool-use id off the request _meta", () => {
    expect(toolUseIdOf({ "claudecode/toolUseId": CALL })).toBe(CALL);
    expect(toolUseIdOf(undefined)).toBeUndefined();
    expect(toolUseIdOf({ "claudecode/toolUseId": 7 })).toBeUndefined();
  });
});

describe("inject-posture.sh", () => {
  test("records the live mode for the server to take, and leaves the tool input alone", () => {
    const { stdout, exitCode } = runHook({
      session_id: "5d288149-f8b3-4cca-87ac-df1e7ecb5a50",
      tool_use_id: CALL,
      permission_mode: "acceptEdits",
      tool_name: "mcp__plugin_dragoman_bridge__codex_run",
      tool_input: { prompt: "p", cwd: "/x" },
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe(""); // no updatedInput: the auto-mode classifier sees the call as written
    expect(takeLiveMode(CALL, env)).toBe("acceptEdits");
  });

  test("leaves no temp files behind", () => {
    runHook({ tool_use_id: CALL, permission_mode: "auto" });
    expect(readdirSync(liveModeDir(env))).toEqual([CALL]);
  });

  test("writes nothing for a missing mode or id, or an unsafe id", () => {
    expect(runHook({ tool_use_id: CALL }).exitCode).toBe(0);
    expect(runHook({ permission_mode: "plan" }).exitCode).toBe(0);
    expect(runHook({ tool_use_id: "../../evil", permission_mode: "plan" }).exitCode).toBe(0);
    expect(existsSync(liveModeDir(env))).toBe(false);
    expect(existsSync(join(runtime, "evil"))).toBe(false);
  });

  test("hooks.json routes all three provisioning tools through the hook", () => {
    const hooks = JSON.parse(readFileSync(join(import.meta.dir, "..", "packaging", "hooks.json"), "utf8"));
    const matcher = new RegExp(`^(?:${hooks.hooks.PreToolUse[0].matcher})$`);
    for (const tool of ["codex_run", "codex_continue", "codex_review"]) {
      expect(matcher.test(`mcp__plugin_dragoman_bridge__${tool}`)).toBe(true);
    }
    expect(matcher.test("mcp__plugin_dragoman_bridge__codex_status")).toBe(false);
  });
});
