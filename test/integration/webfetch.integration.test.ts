/**
 * Live WebFetch mapping on the production path. A Claude `WebFetch(domain:x)` rule
 * means "you may reach host x". Codex has no fetch tool, so the mirror honours it two
 * ways at once: a network allow for x AND an implicit curl/wget execpolicy allow — so
 * Codex reaches x via the shell WITHOUT a prompt, the way Claude's fetch tool would.
 * The network allowlist scopes WHICH hosts the fetchers can hit.
 *
 * Verified against codex-cli 0.150.1: under manual (which would otherwise prompt for
 * curl), a WebFetch-allowed host is reached with no elicitation, and a host NOT on the
 * allowlist is blocked (the command still runs un-prompted, but the network fences it).
 */
import { describe, expect } from "bun:test";
import { verifyOnce } from "./ratchet.ts";
import { profiledRuns, ScriptedElicitation, settings, settle, withTempDir } from "./harness.ts";

const curl = (host: string) =>
  `Run exactly this one shell command and report its full output verbatim, then stop: ` +
  `curl -sS -m 12 -o /dev/null -w 'http=%{http_code}' https://${host}`;

describe("WebFetch(domain:) → reach the host with no prompt (production path)", () => {
  verifyOnce("a WebFetch-allowed host is reached with no elicitation under manual", async () => {
    await withTempDir((homeParent) =>
      withTempDir(async (cwd) => {
        const elicitation = new ScriptedElicitation("decline");
        const runs = profiledRuns(settings({ allow: ["WebFetch(domain:example.com)"] }), elicitation, homeParent);
        const handle = await runs.start(curl("example.com"), cwd, "default");
        const final = await settle(runs, handle);
        expect(final.status).toBe("done");
        expect(elicitation.asks.length).toBe(0); // implicit curl allow: never prompted
        expect(final.result ?? "").toContain("200"); // network allow: reached
      }),
    );
  });

  verifyOnce("a host NOT on the allowlist is blocked (no prompt, unreachable)", async () => {
    await withTempDir((homeParent) =>
      withTempDir(async (cwd) => {
        const elicitation = new ScriptedElicitation("decline");
        const runs = profiledRuns(settings({ allow: ["WebFetch(domain:example.com)"] }), elicitation, homeParent);
        const handle = await runs.start(curl("example.org"), cwd, "default");
        const final = await settle(runs, handle);
        expect(final.status).toBe("done");
        expect(elicitation.asks.length).toBe(0); // curl still runs un-prompted…
        expect(final.result ?? "").not.toContain("http=200"); // …but the network fence blocks the untrusted host
      }),
    );
  });
});
