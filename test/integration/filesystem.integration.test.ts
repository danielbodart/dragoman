/**
 * Live filesystem-axis verification on the PRODUCTION path: does Codex honour the
 * `filesystem` rules the mirror emits into the permission profile?
 *
 * Two levels, mirroring how scope + network are verified:
 *  - Read-deny is model-free — `command/exec` under a named `permissionProfile`
 *    (deterministic, no turn). It proves `denyRead → "deny"` bites AND that the
 *    table AUGMENTS the base (a sibling read + a cwd write still succeed), the real
 *    regression risk when adding a `filesystem` table to a `:workspace` profile.
 *  - The write-carve (`denyWrite → "read"` downgrade of a subpath inside a live
 *    writable root) needs `runtimeWorkspaceRoots`, which `command/exec` has no
 *    equivalent for, so it rides one real thread turn — ratcheted via `verifyOnce`.
 */
import { describe, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AppServerProcess } from "../../src/codex.ts";
import { ensureCodexHome } from "../../src/codex-home.ts";
import { allProfiles } from "../../src/mirror.ts";
import { startPump } from "../../src/pump.ts";
import { ThreadRuns } from "../../src/thread-run.ts";
import type { EffectiveSettings } from "../../src/settings.ts";
import { verifyOnce } from "./ratchet.ts";
import { execProfiled, ScriptedElicitation, settings, settle, withProfiledCodex, withTempDir } from "./harness.ts";

const WORKSPACE = "dragoman-workspace";

describe("filesystem axis is honoured (profile → command/exec)", () => {
  verifyOnce("denyRead → a file is unreadable, while a sibling read and a cwd write still work", async () => {
    await withTempDir(async (cwd) => {
      const secret = join(cwd, "secret.txt");
      const publicFile = join(cwd, "public.txt");
      writeFileSync(secret, "TOPSECRET\n");
      writeFileSync(publicFile, "hello\n");
      const effective = settings({ denyRead: [secret] });
      await withProfiledCodex(effective, async (conn) => {
        // denyRead → "deny": the read is refused.
        expect((await execProfiled(conn, ["cat", secret], cwd, WORKSPACE)).exitCode).not.toBe(0);
        // The table AUGMENTS the base: a sibling stays readable…
        expect((await execProfiled(conn, ["cat", publicFile], cwd, WORKSPACE)).exitCode).toBe(0);
        // …and the base's cwd write is NOT clobbered by adding a filesystem table.
        expect((await execProfiled(conn, ["touch", join(cwd, "in.txt")], cwd, WORKSPACE)).exitCode).toBe(0);
      });
    });
  });
});

describe("filesystem write-carve is honoured (profile + runtimeWorkspaceRoots → real turn)", () => {
  verifyOnce("denyWrite carves a read-only subpath out of a writable workspace root", async () => {
    await withTempDir((homeParent) =>
      withTempDir(async (cwd) => {
        const { mkdirSync } = await import("node:fs");
        mkdirSync(join(cwd, "sub"), { recursive: true });
        writeFileSync(join(cwd, "sub", "keep.txt"), "K0");
        writeFileSync(join(cwd, "top.txt"), "T0");
        const effective = (): EffectiveSettings => settings({ denyWrite: [join(cwd, "sub")] });
        const layout = { realHome: join(homedir(), ".codex"), isolatedHome: join(homeParent, "codex-home") };

        const runs: ThreadRuns = new ThreadRuns(
          () => AppServerProcess.start(["codex", "app-server"], { CODEX_HOME: ensureCodexHome(allProfiles(effective()), layout) }),
          (conn) => startPump(conn, runs, new ScriptedElicitation()),
          Date.now,
          effective,
        );

        const handle = await runs.start(
          "Run exactly this shell command and report nothing else: printf X >> top.txt; printf X >> sub/keep.txt; echo DONE",
          cwd,
          "dontAsk",
        );
        const final = await settle(runs, handle);
        expect(final.status).toBe("done");
        // The writable root took the write; the carved subpath (read-only) did not.
        expect((await Bun.file(join(cwd, "top.txt")).text())).toBe("T0X");
        expect((await Bun.file(join(cwd, "sub", "keep.txt")).text())).toBe("K0");
      }),
    );
  });
});
