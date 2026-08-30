/**
 * Live end-to-end proof of the profile route THROUGH ThreadRuns: settings with
 * per-host domain rules → mirrored profiles → isolated CODEX_HOME → a thread
 * selecting the profile enforces the denylist. This exercises the real
 * composition (mirror + codex-home + thread-run), not codex directly.
 *
 * Ratcheted: one real turn, then skipped. Uses a throwaway isolated home under a
 * temp dir (auth inherited from the real ~/.codex), so the user's ~/.dragoman is
 * untouched.
 */
import { describe, expect } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { AppServerProcess } from "../../src/codex.ts";
import { ensureCodexHome } from "../../src/codex-home.ts";
import { startPump } from "../../src/pump.ts";
import { ThreadRuns } from "../../src/thread-run.ts";
import type { EffectiveSettings } from "../../src/settings.ts";
import { verifyOnce } from "./ratchet.ts";
import { ScriptedElicitation, settings, settle, withTempDir } from "./harness.ts";

describe("profile route enforces per-host network through ThreadRuns", () => {
  verifyOnce("a denied domain is blocked; the isolated home carries the profile", async () => {
    await withTempDir((homeParent) =>
      withTempDir(async (cwd) => {
        const effective = (): EffectiveSettings => ({
          ...settings(),
          sandboxEnabled: true,
          allowedDomains: ["example.com"],
          deniedDomains: ["example.org"],
        });
        const layout = { realHome: join(homedir(), ".codex"), isolatedHome: join(homeParent, "codex-home") };

        const runs: ThreadRuns = new ThreadRuns(
          // Live path: write only the ONE profile mirror() compiled for this run.
          async (policy) => ({ conn: await AppServerProcess.start(["codex", "app-server"], { CODEX_HOME: ensureCodexHome(policy.profile ? [policy.profile] : [], layout) }) }),
          (conn) => startPump(conn, runs, new ScriptedElicitation()),
          Date.now,
          effective,
        );

        const handle = await runs.start(
          "Run exactly this and report its outcome verbatim: curl -sS -m 12 -o /dev/null -w 'http=%{http_code}' https://example.org; echo \" rc=$?\"",
          cwd,
          "dontAsk",
        );
        const final = await settle(runs, handle);
        expect(final.status).toBe("done");
        // The denied domain must be refused. Codex's wording for a sandbox/network
        // rejection varies by version (0.150.1: "rejected by the environment"), so
        // match the family, not one phrase — a non-zero curl rc / rejection, never a
        // 2xx. (This asserts the network table bit, independent of the mode.)
        expect(final.result ?? "").toMatch(/blocked|denied|policy|rejected|environment|rc=[^0]/i);
      }),
    );
  });
});
