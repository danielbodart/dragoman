/**
 * Live approval-bridge verification — the thing this whole project exists for.
 *
 * An approval only arises from a real model turn, and (verified against
 * codex-cli 0.150.1) the app-server round-trips `item/commandExecution/requestApproval`
 * to the client under `approvalPolicy: untrusted` — i.e. Claude's `plan` posture.
 * Under `on-request` Codex self-approves via an internal `autoApprovalReview` and
 * rarely asks the client, so `plan` is the reliable trigger. The command arrives
 * shell-wrapped (`/bin/bash -lc '<cmd>'`), which the pump unwraps.
 *
 * Each test wires the full `ThreadRuns` + pump stack against real Codex with a
 * `ScriptedElicitation` for the human, and spends ONE turn — ratcheted via
 * `verifyOnce`, so paid at most once. The evidence is whether the elicitation was
 * asked (`asks`): the allow path auto-accepts and the deny path pre-declines, both
 * WITHOUT asking; an unmatched command asks.
 */
import { describe, expect } from "bun:test";
import { startPump } from "../../src/pump.ts";
import { ThreadRuns } from "../../src/thread-run.ts";
import { verifyOnce } from "./ratchet.ts";
import { ScriptedElicitation, settings, settle, withCodex, withTempDir } from "./harness.ts";
import type { EffectiveSettings } from "../../src/settings.ts";

/** Run a single `plan`-posture Codex turn wired to a scripted elicitation. */
async function turn(effective: EffectiveSettings, prompt: string): Promise<{ asks: number; status: string }> {
  const elicitation = new ScriptedElicitation("decline");
  return withCodex((conn) =>
    withTempDir(async (cwd) => {
      const runs: ThreadRuns = new ThreadRuns(
        async () => conn,
        (c) => startPump(c, runs, elicitation),
        Date.now,
        () => effective,
      );
      const handle = await runs.start(prompt, cwd, "plan");
      const final = await settle(runs, handle);
      return { asks: elicitation.asks.length, status: final.status };
    }),
  );
}

const RUN_ECHO = "Use your shell to run exactly this one command and then stop; do not run anything else: echo dragoman-probe hi";

describe("the approval bridge fires on a real turn", () => {
  verifyOnce("an unmatched command prompts the human", async () => {
    const { asks } = await turn(settings(), RUN_ECHO);
    expect(asks).toBeGreaterThan(0);
  });

  verifyOnce("a command matching an allow rule is auto-accepted (no prompt)", async () => {
    const { asks } = await turn(settings({ allow: ["Bash(echo dragoman-probe:*)"] }), RUN_ECHO);
    expect(asks).toBe(0);
  });

  verifyOnce("a command matching a deny rule is pre-declined (no prompt)", async () => {
    const { asks } = await turn(settings({ deny: ["Bash(echo:*)"] }), RUN_ECHO);
    expect(asks).toBe(0);
  });
});
