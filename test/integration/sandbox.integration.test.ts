/**
 * Live sandbox/network verification — does Codex HONOUR the `sandboxPolicy`
 * `mirror()` emits? Each test drives the real `command/exec` RPC (no model turn)
 * with a policy built by the mirror, and asserts on the process exit code.
 *
 * These replace the manual `claude -p` probes in docs/MIRROR-VERIFICATION.md with
 * executable ones. Ratcheted via `verifyOnce`: each runs once until green, then
 * is skipped (and skipped entirely where `codex` isn't installed).
 */
import { describe, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { mirror } from "../../src/mirror.ts";
import { verifyOnce } from "./ratchet.ts";
import { exec, settings, withCodex, withTempDir } from "./harness.ts";

describe("sandbox scope is honoured (mirror → command/exec)", () => {
  verifyOnce("bypassPermissions (danger-full-access) can write outside the workspace", async () => {
    await withCodex((conn) =>
      withTempDir((cwd) =>
        withTempDir(async (outside) => {
          const policy = mirror(settings(), "bypassPermissions", cwd);
          const res = await exec(conn, ["touch", join(outside, "probe.txt")], cwd, policy.sandboxPolicy);
          expect(res.exitCode).toBe(0);
        }),
      ),
    );
  });

  verifyOnce("dontAsk (workspace-write) allows writes in cwd but blocks outside", async () => {
    await withCodex((conn) =>
      withTempDir((cwd) =>
        withTempDir(async (outside) => {
          const policy = mirror(settings(), "dontAsk", cwd);
          const inside = await exec(conn, ["touch", join(cwd, "probe.txt")], cwd, policy.sandboxPolicy);
          expect(inside.exitCode).toBe(0);
          const beyond = await exec(conn, ["touch", join(outside, "probe.txt")], cwd, policy.sandboxPolicy);
          expect(beyond.exitCode).not.toBe(0);
        }),
      ),
    );
  });

  verifyOnce("additionalDirectories extends the writable roots", async () => {
    await withCodex((conn) =>
      withTempDir((cwd) =>
        withTempDir(async (extra) => {
          const policy = mirror(settings({ additionalDirectories: [extra] }), "dontAsk", cwd);
          const res = await exec(conn, ["touch", join(extra, "probe.txt")], cwd, policy.sandboxPolicy);
          expect(res.exitCode).toBe(0);
        }),
      ),
    );
  });

  verifyOnce("plan (read-only) allows reads but blocks writes", async () => {
    await withCodex((conn) =>
      withTempDir(async (cwd) => {
        const existing = join(cwd, "seed.txt");
        writeFileSync(existing, "seed");
        const policy = mirror(settings(), "plan", cwd);
        const read = await exec(conn, ["cat", existing], cwd, policy.sandboxPolicy);
        expect(read.exitCode).toBe(0);
        const write = await exec(conn, ["touch", join(cwd, "probe.txt")], cwd, policy.sandboxPolicy);
        expect(write.exitCode).not.toBe(0);
      }),
    );
  });
});

describe("network access is honoured (mirror → command/exec)", () => {
  const curl = ["curl", "-sS", "-m", "10", "-o", "/dev/null", "https://example.com"];

  verifyOnce("no Claude sandbox → network is ON (mirrors Claude's own network)", async () => {
    await withCodex((conn) =>
      withTempDir(async (cwd) => {
        const policy = mirror(settings(), "dontAsk", cwd); // sandbox not enabled → network open
        const res = await exec(conn, curl, cwd, policy.sandboxPolicy);
        expect(res.exitCode).toBe(0);
      }),
    );
  });

  verifyOnce("under Claude's sandbox with no allowlist → network is blocked", async () => {
    await withCodex((conn) =>
      withTempDir(async (cwd) => {
        const policy = mirror(settings({ sandboxEnabled: true }), "dontAsk", cwd);
        const res = await exec(conn, curl, cwd, policy.sandboxPolicy);
        expect(res.exitCode).not.toBe(0);
      }),
    );
  });

  verifyOnce("under Claude's sandbox, a non-empty allowlist → network is enabled", async () => {
    await withCodex((conn) =>
      withTempDir(async (cwd) => {
        const policy = mirror(settings({ sandboxEnabled: true, allowedDomains: ["example.com"] }), "dontAsk", cwd);
        const res = await exec(conn, curl, cwd, policy.sandboxPolicy);
        expect(res.exitCode).toBe(0);
      }),
    );
  });
});
