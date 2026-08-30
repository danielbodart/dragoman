/**
 * Live config-layer enforcement: does the execpolicy `.rules` file the mirror emits
 * (from Claude's allow/deny Bash rules) actually bind on the PRODUCTION path — for
 * every command, independent of the approval round-trip?
 *
 * Verified against codex-cli 0.150.1 (see docs/MAPPING.md):
 *  - a `deny` rule → `forbidden`: the command is blocked even in `bypassPermissions`
 *    (approvalPolicy `never` + dangerFullAccess), which round-trips NO approval — the
 *    gap the per-approval gate can't reach (finding [B]).
 *  - an `allow` rule → `allow`: the command runs WITHOUT prompting even under
 *    `untrusted` (manual), overriding the mode's base — and the human is never asked.
 *
 * Each spends one real model turn through the full ThreadRuns + pump stack; ratcheted.
 */
import { describe, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { verifyOnce } from "./ratchet.ts";
import { profiledRuns, resultText, ScriptedElicitation, settings, settle, withTempDir } from "./harness.ts";

describe("execpolicy rules bind on the production path", () => {
  verifyOnce("a deny rule forbids the command even in bypassPermissions (never)", async () => {
    await withTempDir((homeParent) =>
      withTempDir(async (cwd) => {
        const target = join(cwd, "made.txt");
        const elicitation = new ScriptedElicitation("accept");
        const runs = profiledRuns(settings({ deny: ["Bash(touch:*)"] }), elicitation, homeParent);
        const handle = await runs.start(`Run exactly this one shell command, then stop: touch ${target}`, cwd, "bypassPermissions");
        const final = await settle(runs, handle);
        expect(final.status).toBe("done");
        expect(existsSync(target)).toBe(false); // forbidden rule blocked it, despite never-ask
      }),
    );
  });

  verifyOnce("an allow rule runs the command with no prompt under manual (untrusted)", async () => {
    await withTempDir((homeParent) =>
      withTempDir(async (cwd) => {
        const elicitation = new ScriptedElicitation("decline");
        const runs = profiledRuns(settings({ allow: ["Bash(python3:*)"] }), elicitation, homeParent);
        const handle = await runs.start(
          `Run exactly this one shell command and report only its output: python3 -c "print('PLUM-8842')" — then stop.`,
          cwd,
          "default",
        );
        const final = await settle(runs, handle);
        expect(final.status).toBe("done");
        expect(elicitation.asks.length).toBe(0); // allow rule pre-approved it: the human was never asked
        expect(resultText(final)).toContain("PLUM-8842");
      }),
    );
  });
});
