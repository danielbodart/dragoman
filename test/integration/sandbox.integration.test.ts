/**
 * Live sandbox/network verification on the PRODUCTION path: does Codex honour the
 * permission PROFILE the mirror emits? Each test spawns codex against an isolated
 * home carrying the mirrored profiles, then runs `command/exec` under a named
 * `permissionProfile` (no thread/turn/model — deterministic and free) and asserts
 * on the exit code.
 *
 * `additionalDirectories` (writable roots) is NOT here: it rides `thread/start`'s
 * `runtimeWorkspaceRoots`, which `command/exec` has no equivalent for — that is
 * covered as a thread-param assertion in `pump.test.ts` and end-to-end in
 * `profile.integration.test.ts`. Ratcheted via `verifyOnce`.
 */
import { describe, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { exec, execProfiled, settings, withCodex, withProfiledCodex, withTempDir } from "./harness.ts";
import { verifyOnce } from "./ratchet.ts";

// Scope under test is chosen the production way — by the mode whose compiled profile
// carries it: `acceptEdits` → the workspace profile, `default` → the read-only one.
describe("sandbox scope is honoured (profile → command/exec)", () => {
  verifyOnce("danger (sandbox enum, the bypass posture) can write outside the workspace", async () => {
    // bypassPermissions has no profile — :danger-full-access is not an extendable
    // base — so thread-run uses the sandbox enum; here we exercise the same path.
    await withCodex((conn) =>
      withTempDir((cwd) =>
        withTempDir(async (outside) => {
          const res = await exec(conn, ["touch", join(outside, "probe.txt")], cwd, { type: "dangerFullAccess" });
          expect(res.exitCode).toBe(0);
        }),
      ),
    );
  });

  verifyOnce("workspace profile allows cwd writes but blocks outside", async () => {
    await withProfiledCodex(settings(), "acceptEdits", (conn, profile) =>
      withTempDir((cwd) =>
        withTempDir(async (outside) => {
          expect((await execProfiled(conn, ["touch", join(cwd, "in.txt")], cwd, profile)).exitCode).toBe(0);
          expect((await execProfiled(conn, ["touch", join(outside, "out.txt")], cwd, profile)).exitCode).not.toBe(0);
        }),
      ),
    );
  });

  verifyOnce("read-only profile allows reads but blocks writes", async () => {
    await withProfiledCodex(settings(), "default", (conn, profile) =>
      withTempDir(async (cwd) => {
        const seed = join(cwd, "seed.txt");
        writeFileSync(seed, "hi");
        expect((await execProfiled(conn, ["cat", seed], cwd, profile)).exitCode).toBe(0);
        expect((await execProfiled(conn, ["touch", join(cwd, "w.txt")], cwd, profile)).exitCode).not.toBe(0);
      }),
    );
  });
});

describe("network is honoured (profile → command/exec)", () => {
  const curl = ["curl", "-sS", "-m", "10", "-o", "/dev/null", "https://example.com"];

  verifyOnce("no Claude sandbox → network ON", async () => {
    await withProfiledCodex(settings(), "acceptEdits", (conn, profile) =>
      withTempDir(async (cwd) => {
        expect((await execProfiled(conn, curl, cwd, profile)).exitCode).toBe(0);
      }),
    );
  });

  verifyOnce("sandbox on, no allowlist → network blocked", async () => {
    await withProfiledCodex(settings({ sandboxEnabled: true }), "acceptEdits", (conn, profile) =>
      withTempDir(async (cwd) => {
        expect((await execProfiled(conn, curl, cwd, profile)).exitCode).not.toBe(0);
      }),
    );
  });

  verifyOnce("sandbox on, allowlisted domain → reachable", async () => {
    await withProfiledCodex(settings({ sandboxEnabled: true, allowedDomains: ["example.com"] }), "acceptEdits", (conn, profile) =>
      withTempDir(async (cwd) => {
        expect((await execProfiled(conn, curl, cwd, profile)).exitCode).toBe(0);
      }),
    );
  });
});
