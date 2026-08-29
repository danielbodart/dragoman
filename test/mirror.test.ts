import { describe, expect, test } from "bun:test";
import { allProfiles, filesystemFor, mirror, profileFor, resolveMode } from "../src/mirror.ts";
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

describe("mirror — mode → approval + profile scope", () => {
  test("plan → untrusted + read-only profile", () => {
    const p = mirror(settings(), "plan");
    expect(p.approvalPolicy).toBe("untrusted");
    expect(p.profile!.base).toBe(":read-only");
  });

  test("default → on-request + workspace profile", () => {
    const p = mirror(settings(), "default");
    expect(p.approvalPolicy).toBe("on-request");
    expect(p.profile!.base).toBe(":workspace");
  });

  test("bypassPermissions → never, no profile (danger uses the sandbox enum)", () => {
    const p = mirror(settings(), "bypassPermissions");
    expect(p.approvalPolicy).toBe("never");
    expect(p.profile).toBeUndefined();
  });

  test("dontAsk → never + workspace profile", () => {
    const p = mirror(settings(), "dontAsk");
    expect(p.approvalPolicy).toBe("never");
    expect(p.profile!.base).toBe(":workspace");
  });

  // manual/acceptEdits/auto share default's posture: on-request + workspace.
  // (auto ↔ on-request is the intended pairing — both delegate accept/decline to
  // a model, Codex's autoApprovalReview; see docs/MIRROR-VERIFICATION.md.)
  for (const mode of ["manual", "acceptEdits", "auto"] as const) {
    test(`${mode} → on-request + workspace profile (same as default)`, () => {
      const p = mirror(settings(), mode);
      expect(p.approvalPolicy).toBe("on-request");
      expect(p.profile!.base).toBe(":workspace");
    });
  }
});

describe("mirror — network posture → profile.network.enabled", () => {
  const enabled = (s: Partial<EffectiveSettings>) => mirror(settings(s), "default").profile!.network!.enabled;

  test("no Claude sandbox → network ON (mirrors Claude's own full network)", () => {
    expect(enabled({})).toBe(true);
  });
  test("under Claude's sandbox, no allowlist → network denied", () => {
    expect(enabled({ sandboxEnabled: true })).toBe(false);
  });
  test("under Claude's sandbox, an allowlist enables network", () => {
    expect(enabled({ sandboxEnabled: true, allowedDomains: ["api.example.com"] })).toBe(true);
  });
  test("under Claude's sandbox, strictAllowlist enables network", () => {
    expect(enabled({ sandboxEnabled: true, strictAllowlist: true })).toBe(true);
  });
  test("under Claude's sandbox, a WebFetch(domain:) allow rule enables network", () => {
    // Claude merges WebFetch(domain:...) allow rules into the sandbox network allowlist.
    expect(enabled({ sandboxEnabled: true, allow: ["WebFetch(domain:example.com)"] })).toBe(true);
  });
});

describe("mirror — allow rules → execpolicy amendments", () => {
  test("a Bash allow rule becomes a command-token prefix", () => {
    const p = mirror(settings({ allow: ["Bash(npm run test:*)"] }), "default");
    expect(p.execpolicyAmendments).toEqual([["npm", "run", "test"]]);
  });

  test("non-Bash rules are ignored", () => {
    const p = mirror(settings({ allow: ["Read(/src/**)", "WebFetch(domain:example.com)"] }), "default");
    expect(p.execpolicyAmendments).toEqual([]);
  });

  test("a bare Bash (allow-all) does NOT become an empty-prefix allow-all", () => {
    // An empty prefix would disable approval entirely — never emit it.
    const p = mirror(settings({ allow: ["Bash"] }), "default");
    expect(p.execpolicyAmendments).toEqual([]);
  });

  test("multiple Bash rules each produce a prefix", () => {
    const p = mirror(settings({ allow: ["Bash(git status)", "Bash(ls -la)"] }), "default");
    expect(p.execpolicyAmendments).toEqual([["git", "status"], ["ls", "-la"]]);
  });
});

describe("mirror — profiles (the unified scope + network axis)", () => {
  test("posture picks the base scope: plan→read-only, default→workspace, bypass→none", () => {
    expect(profileFor(settings(), "plan")!.base).toBe(":read-only");
    expect(profileFor(settings(), "default")!.base).toBe(":workspace");
    expect(profileFor(settings(), "bypassPermissions")).toBeUndefined();
  });

  test("profile id is derived from the base scope", () => {
    expect(profileFor(settings(), "plan")!.id).toBe("dragoman-read-only");
    expect(profileFor(settings(), "default")!.id).toBe("dragoman-workspace");
  });

  test("network mirrors Claude: enabled when unsandboxed, domains from allow/deny + WebFetch", () => {
    const p = profileFor(settings({ sandboxEnabled: true, allowedDomains: ["a.com"], deniedDomains: ["b.com"], allow: ["WebFetch(domain:c.com)"] }), "default");
    expect(p!.network).toEqual({ enabled: true, domains: [["a.com", "allow"], ["c.com", "allow"], ["b.com", "deny"]] });
  });

  test("no sandbox → network enabled, no domains", () => {
    expect(profileFor(settings(), "default")!.network).toEqual({ enabled: true, domains: [] });
  });

  test("allProfiles yields one profile per extendable base, sharing the network rules", () => {
    const ps = allProfiles(settings({ sandboxEnabled: true, allowedDomains: ["a.com"] }));
    expect(ps.map((p) => p.base)).toEqual([":read-only", ":workspace"]);
    expect(new Set(ps.map((p) => JSON.stringify(p.network))).size).toBe(1); // same network everywhere
    expect(ps[1]!.network!.domains).toEqual([["a.com", "allow"]]);
  });
});

describe("filesystemFor — the four lists → filesystem access", () => {
  test("each list maps to its access level (denyWrite is a read-only DOWNGRADE, not deny)", () => {
    const fs = filesystemFor(settings({
      denyRead: ["/a/secret"], denyWrite: ["/a/ro"], allowWrite: ["/b/out"], allowRead: ["/c/in"],
    }));
    expect(new Map(fs.paths)).toEqual(new Map([
      ["/a/secret", "deny"], ["/a/ro", "read"], ["/b/out", "write"], ["/c/in", "read"],
    ]));
    expect(fs.workspaceRoots).toEqual([]);
  });

  test("empty settings → empty axis (no table gets rendered)", () => {
    const fs = filesystemFor(settings());
    expect(fs.paths).toEqual([]);
    expect(fs.workspaceRoots).toEqual([]);
  });

  test("relative paths and globs anchor under :workspace_roots; absolutes at top level", () => {
    const fs = filesystemFor(settings({ denyRead: ["**/*.env", ".aws"], allowWrite: ["/abs/dir"] }));
    expect(fs.paths).toEqual([["/abs/dir", "write"]]);
    expect(new Map(fs.workspaceRoots)).toEqual(new Map([["**/*.env", "deny"], [".aws", "deny"]]));
  });

  test("a path in several lists folds by precedence: deny > read(denyWrite) > write > read", () => {
    // /x is in every list; denyRead must win (most restrictive).
    const both = filesystemFor(settings({
      denyRead: ["/x"], denyWrite: ["/x"], allowWrite: ["/x"], allowRead: ["/x"],
    }));
    expect(both.paths).toEqual([["/x", "deny"]]);
    // denyWrite beats allowWrite for the same path (read-only wins over write).
    const ro = filesystemFor(settings({ denyWrite: ["/y"], allowWrite: ["/y"] }));
    expect(ro.paths).toEqual([["/y", "read"]]);
  });

  test("blank entries are dropped, not emitted as empty keys", () => {
    const fs = filesystemFor(settings({ denyRead: ["  ", ""] }));
    expect(fs.paths).toEqual([]);
    expect(fs.workspaceRoots).toEqual([]);
  });

  test("profileFor carries the filesystem axis; allProfiles shares it across bases", () => {
    const p = profileFor(settings({ denyRead: ["/s"] }), "default");
    expect(p!.filesystem!.paths).toEqual([["/s", "deny"]]);
    const ps = allProfiles(settings({ denyRead: ["/s"] }));
    expect(new Set(ps.map((x) => JSON.stringify(x.filesystem))).size).toBe(1);
  });
});

describe("mirror — deny rules → deny prefixes", () => {
  test("a Bash deny rule becomes a command-token prefix", () => {
    const p = mirror(settings({ deny: ["Bash(curl:*)", "Bash(git push:*)"] }), "default");
    expect(p.denyPrefixes).toEqual([["curl"], ["git", "push"]]);
  });

  test("non-Bash and bare-Bash deny rules are ignored", () => {
    const p = mirror(settings({ deny: ["Read(/etc/**)", "Bash"] }), "default");
    expect(p.denyPrefixes).toEqual([]);
  });
});
