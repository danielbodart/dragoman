import { describe, expect, test } from "bun:test";
import { mirror, resolveMode } from "../src/mirror.ts";
import type { EffectiveSettings } from "../src/settings.ts";

/** Effective settings with sensible empty defaults, overridable field by field. */
function settings(overrides: Partial<EffectiveSettings> = {}): EffectiveSettings {
  return {
    allow: [], deny: [], ask: [], additionalDirectories: [],
    denyRead: [], denyWrite: [], allowRead: [], allowWrite: [],
    allowedDomains: [], deniedDomains: [],
    ...overrides,
  };
}

describe("resolveMode (the three-tier posture)", () => {
  test("an explicit posture wins over the static defaultMode", () => {
    expect(resolveMode(settings({ defaultMode: "default" }), "plan")).toBe("plan");
  });

  test("falls back to the static defaultMode when no posture is passed", () => {
    expect(resolveMode(settings({ defaultMode: "acceptEdits" }))).toBe("acceptEdits");
  });

  test("falls back to the safe default when neither is set", () => {
    expect(resolveMode(settings())).toBe("default");
  });

  test("an unrecognised mode string degrades to the safe default, never throws", () => {
    expect(resolveMode(settings({ defaultMode: "some-future-mode" }))).toBe("default");
    expect(resolveMode(settings(), "nonsense")).toBe("default");
  });
});

describe("mirror — mode → approval + sandbox", () => {
  test("plan → untrusted + read-only", () => {
    const p = mirror(settings(), "plan", "/repo");
    expect(p.approvalPolicy).toBe("untrusted");
    expect(p.sandbox).toBe("read-only");
    expect(p.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
  });

  test("default → on-request + workspace-write with cwd writable", () => {
    const p = mirror(settings(), "default", "/repo");
    expect(p.approvalPolicy).toBe("on-request");
    expect(p.sandbox).toBe("workspace-write");
    expect(p.sandboxPolicy).toMatchObject({ type: "workspaceWrite", writableRoots: ["/repo"], networkAccess: false });
  });

  test("bypassPermissions → never + danger-full-access", () => {
    const p = mirror(settings(), "bypassPermissions", "/repo");
    expect(p.approvalPolicy).toBe("never");
    expect(p.sandbox).toBe("danger-full-access");
    expect(p.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
  });

  test("dontAsk → never (no prompting) but still sandboxed", () => {
    const p = mirror(settings(), "dontAsk", "/repo");
    expect(p.approvalPolicy).toBe("never");
    expect(p.sandbox).toBe("workspace-write");
  });

  // manual/acceptEdits/auto all share default's posture: on-request +
  // workspace-write. (auto ↔ on-request is the intended pairing — both delegate
  // the accept/decline call to a model, Codex's autoApprovalReview; see
  // docs/MIRROR-VERIFICATION.md.)
  for (const mode of ["manual", "acceptEdits", "auto"] as const) {
    test(`${mode} → on-request + workspace-write (same as default)`, () => {
      const p = mirror(settings(), mode, "/repo");
      expect(p.approvalPolicy).toBe("on-request");
      expect(p.sandbox).toBe("workspace-write");
      expect(p.sandboxPolicy).toMatchObject({ type: "workspaceWrite", writableRoots: ["/repo"], networkAccess: false });
    });
  }
});

describe("mirror — sandbox settings → SandboxPolicy", () => {
  test("additionalDirectories extend writableRoots after the cwd", () => {
    const p = mirror(settings({ additionalDirectories: ["/data", "/cache"] }), "default", "/repo");
    expect(p.sandboxPolicy).toMatchObject({ writableRoots: ["/repo", "/data", "/cache"] });
  });

  test("a network allowlist flips networkAccess on", () => {
    const p = mirror(settings({ allowedDomains: ["api.example.com"] }), "default", "/repo");
    expect(p.sandboxPolicy).toMatchObject({ networkAccess: true });
  });

  test("strictAllowlist alone also enables network", () => {
    const p = mirror(settings({ strictAllowlist: true }), "default", "/repo");
    expect(p.sandboxPolicy).toMatchObject({ networkAccess: true });
  });

  test("no network config keeps network denied (Claude's default)", () => {
    expect(mirror(settings(), "default", "/repo").sandboxPolicy).toMatchObject({ networkAccess: false });
  });
});

describe("mirror — allow rules → execpolicy amendments", () => {
  test("a Bash allow rule becomes a command-token prefix", () => {
    const p = mirror(settings({ allow: ["Bash(npm run test:*)"] }), "default", "/repo");
    expect(p.execpolicyAmendments).toEqual([["npm", "run", "test"]]);
  });

  test("non-Bash rules are ignored", () => {
    const p = mirror(settings({ allow: ["Read(/src/**)", "WebFetch(domain:example.com)"] }), "default", "/repo");
    expect(p.execpolicyAmendments).toEqual([]);
  });

  test("a bare Bash (allow-all) does NOT become an empty-prefix allow-all", () => {
    // An empty prefix would disable approval entirely — never emit it.
    const p = mirror(settings({ allow: ["Bash"] }), "default", "/repo");
    expect(p.execpolicyAmendments).toEqual([]);
  });

  test("multiple Bash rules each produce a prefix", () => {
    const p = mirror(settings({ allow: ["Bash(git status)", "Bash(ls -la)"] }), "default", "/repo");
    expect(p.execpolicyAmendments).toEqual([["git", "status"], ["ls", "-la"]]);
  });
});

describe("mirror — deny rules → deny prefixes", () => {
  test("a Bash deny rule becomes a command-token prefix", () => {
    const p = mirror(settings({ deny: ["Bash(curl:*)", "Bash(git push:*)"] }), "default", "/repo");
    expect(p.denyPrefixes).toEqual([["curl"], ["git", "push"]]);
  });

  test("non-Bash and bare-Bash deny rules are ignored", () => {
    const p = mirror(settings({ deny: ["Read(/etc/**)", "Bash"] }), "default", "/repo");
    expect(p.denyPrefixes).toEqual([]);
  });
});
