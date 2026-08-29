/**
 * Live demonstration that long-poll (`ThreadRuns.waitForUpdate`) drives a real
 * turn event-driven — returning on each pump write rather than on a timer.
 *
 * Runs one `dontAsk` turn (never + workspace-write, so no approvals) and follows
 * it purely with `waitForUpdate`, counting wake-ups and comparing to how many
 * calls a fixed 2s-interval poller would have made over the same wall-time. The
 * point isn't a smaller raw count on a short turn (a chatty turn emits several
 * beats); it's that every wake is an EVENT — none waits out the cap — and the
 * poll makes ZERO calls while the run sits quiet, where an interval poller keeps
 * firing. Ratcheted: one turn, then skipped.
 */
import { describe, expect } from "bun:test";
import { verifyOnce } from "./ratchet.ts";
import { ScriptedElicitation, profiledRuns, settings, withTempDir } from "./harness.ts";

describe("long-poll drives a real turn", () => {
  verifyOnce("waitForUpdate reaches completion event-driven, no interval spinning", async () => {
    await withTempDir((homeParent) =>
      withTempDir(async (cwd) => {
        const runs = profiledRuns(settings(), new ScriptedElicitation(), homeParent);
        const handle = await runs.start(
          "Use your shell to run exactly this one command and then stop; do not run anything else: sleep 2 && echo dragoman-longpoll",
          cwd,
          "dontAsk",
        );

        const CAP = 100_000;
        const start = Date.now();
        let revision = 0;
        let wakeups = 0;
        let status: string | undefined;
        for (;;) {
          const update = await runs.waitForUpdate(handle, revision, CAP);
          wakeups += 1;
          revision = update.revision;
          status = update.snapshot?.status;
          if (status === "done" || status === "error") break;
          if (Date.now() - start > 120_000) throw new Error("turn did not complete in time");
        }
        const elapsed = Date.now() - start;
        const intervalPolls = Math.max(1, Math.ceil(elapsed / 2000));
        console.log(
          `[long-poll] status=${status} elapsed=${elapsed}ms wakeups=${wakeups} ` +
            `(a fixed 2s poller would have made ≈${intervalPolls} calls over the same span)`,
        );

        expect(status).toBe("done");
        expect(wakeups).toBeGreaterThan(0);
        // Every wake was an event, none waited out the 100s cap: total time is the
        // turn's own duration, not a multiple of CAP.
        expect(elapsed).toBeLessThan(90_000);
      }),
    );
  });
});
