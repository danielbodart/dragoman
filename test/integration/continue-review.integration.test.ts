/**
 * Live, ratcheted tests for the two paths unit tests can't fully lock:
 *
 *  - codex_continue: proves a thread RESUMES with its context after its run's home
 *    is torn down — which only works because durable state lives in the shared store,
 *    not the ephemeral per-run home (see codex-home.ts). A cold thread can't recall
 *    the planted token; a resumed one can.
 *  - codex_review: proves Codex's dedicated review pass returns a real, file-anchored
 *    finding on an actual diff.
 *
 * Both spend model turns, so they run once-until-green via `verifyOnce` and are skipped
 * on machines without `codex`.
 */
import { describe, expect } from "bun:test";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyOnce } from "./ratchet.ts";
import { profiledRuns, resultText, ScriptedElicitation, settings, settle, withTempDir } from "./harness.ts";

describe("codex_continue (production path: resume after the run's home is gone)", () => {
  verifyOnce("a continuation recalls context from the first turn", async () => {
    await withTempDir((homeParent) =>
      withTempDir(async (cwd) => {
        const runs = profiledRuns(settings(), new ScriptedElicitation("accept"), homeParent);

        const handle = await runs.start(
          "Remember this exact token: BANANA-42. Reply with only the word ok.",
          cwd,
          "default",
        );
        expect((await settle(runs, handle)).status).toBe("done");
        // The first run's isolated home is now disposed (deleted). The rollout survives
        // only in the shared store, so this resume can find it.

        const message = await runs.continueRun(
          handle,
          "What exact token did I ask you to remember earlier? Reply with only that token.",
          "default",
        );
        expect(message).toContain("Continuing");
        const final = await settle(runs, handle);
        expect(final.status).toBe("done");
        expect(resultText(final)).toContain("BANANA-42"); // context carried across the fresh home
      }),
    );
  });
});

describe("codex_review (dedicated review pass over a diff)", () => {
  verifyOnce("returns a file-anchored finding on the uncommitted changes", async () => {
    await withTempDir((homeParent) =>
      withTempDir(async (cwd) => {
        const git = (cmd: string) => execSync(cmd, { cwd, stdio: "pipe" });
        git("git init -q && git config user.email t@t.com && git config user.name t");
        writeFileSync(join(cwd, "sum.js"), "export function sum(xs){let t=0;for(let i=0;i<xs.length;i++)t+=xs[i];return t;}\n");
        git("git add -A && git commit -qm init");
        // Uncommitted change introduces an off-by-one (`<=`) — an obvious defect to flag.
        writeFileSync(join(cwd, "sum.js"), "export function sum(xs){let t=0;for(let i=0;i<=xs.length;i++)t+=xs[i];return t;}\n");

        const runs = profiledRuns(settings(), new ScriptedElicitation("accept"), homeParent);
        const handle = await runs.review(cwd, { type: "uncommittedChanges" }, "default");
        const final = await settle(runs, handle);
        expect(final.status).toBe("done");

        const review = resultText(final);
        expect(review).toContain("sum.js"); // anchored to the changed file
        expect(review.toLowerCase()).toMatch(/loop|boundary|off-by-one|length|<=|past the end/); // named the defect
      }),
    );
  });
});
