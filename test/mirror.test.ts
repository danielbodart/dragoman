import { describe, expect, test } from "bun:test";
import { filesystemFor, mirror, profileFor, resolveMode } from "../src/mirror.ts";
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

  test("falls back to the safe default (default = Manual mode) when neither is set", () => {
    expect(resolveMode(settings())).toBe("default");
  });

  test("'manual' is accepted as the CLI alias of default (resolves as-is, maps the same)", () => {
    expect(resolveMode(settings({ defaultMode: "manual" }))).toBe("manual");
  });

  test("an unrecognised mode string degrades to the safe default, never throws", () => {
    expect(resolveMode(settings({ defaultMode: "some-future-mode" }))).toBe("default");
    expect(resolveMode(settings(), "nonsense")).toBe("default");
  });
});

// The verified mapping (docs/POLICY-COMPILER.md): MODE drives approval (policy +
// reviewer); judged modes force a :workspace sandbox as the review TRIGGER even when
// Claude isn't sandboxing; the sandbox config refines the workspace tables.
function isGranular(p: unknown): boolean {
  return typeof p === "object" && p !== null && "granular" in p;
}

describe("mirror — mode → approvalPolicy (the approval axis)", () => {
  // Auto-write modes need `granular`, not just a `:workspace` scope: edits
  // (apply_patch) are gated by the approval policy, so under `granular` an
  // in-workspace edit auto-runs and only an escape is raised (verified 0.150.1).
  for (const mode of ["auto", "acceptEdits"] as const) {
    test(`${mode} → granular (in-ws writes auto-run, escapes raised)`, () => {
      expect(isGranular(mirror(settings(), mode).approvalPolicy)).toBe(true);
    });
  }
  test("bypassPermissions → never", () => {
    expect(mirror(settings(), "bypassPermissions").approvalPolicy).toBe("never");
  });
  // plan → `on-request`, so reads auto-run (Claude plan explores freely); `untrusted`
  // would raise non-trusted reads and the decline-fallback would block them. Native
  // plan mode refuses writes at the source.
  test("plan → on-request (reads auto-run; writes refused by native plan mode)", () => {
    expect(mirror(settings(), "plan").approvalPolicy).toBe("on-request");
  });
  // The ask/blocked modes raise every write as `untrusted`; where it goes is the
  // reviewer + the commandFallback/fileChange knobs.
  for (const mode of ["default", "manual", "dontAsk"] as const) {
    test(`${mode} → untrusted`, () => {
      expect(mirror(settings(), mode).approvalPolicy).toBe("untrusted");
    });
  }
});

describe("mirror — mode → approvalsReviewer (human vs model)", () => {
  test("auto → auto_review (Codex's model judges escapes)", () => {
    expect(mirror(settings(), "auto").approvalsReviewer).toBe("auto_review");
  });
  for (const mode of ["default", "manual", "acceptEdits"] as const) {
    test(`${mode} → user (escapes routed to the human elicitation)`, () => {
      expect(mirror(settings(), mode).approvalsReviewer).toBe("user");
    });
  }
  // bypass never asks; dontAsk refuses via commandFallback, not a reviewer; plan's
  // native mode refuses writes at the source, so nothing routes to a reviewer.
  for (const mode of ["plan", "dontAsk", "bypassPermissions"] as const) {
    test(`${mode} → no reviewer`, () => {
      expect(mirror(settings(), mode).approvalsReviewer).toBeUndefined();
    });
  }
});

describe("mirror — mode → fallback knobs (commandFallback / fileChange)", () => {
  // dontAsk refuses unmatched commands/edits (only pre-approved run); plan refuses
  // too — a backstop under its native plan mode, mirroring "a write becomes a plan,
  // not a prompt".
  for (const mode of ["dontAsk", "plan"] as const) {
    test(`${mode} refuses unmatched commands and file edits (decline, never asks)`, () => {
      const p = mirror(settings(), mode);
      expect(p.commandFallback).toBe("decline");
      expect(p.fileChange).toBe("decline");
    });
  }
  // acceptEdits does NOT auto-accept escaped edits or inject fs-command allows: under
  // its `granular` policy in-scope edits already auto-run, so these paths only ever
  // see escapes (which Claude prompts for). It elicits like Manual; the policy differs.
  test("acceptEdits does not auto-accept escapes (elicit) and adds no fs-command allows", () => {
    const p = mirror(settings(), "acceptEdits");
    expect(p.fileChange).toBe("elicit");
    expect(p.commandFallback).toBe("elicit");
    expect(p.execpolicyAmendments).toEqual([]); // no ambient fs prefixes; only user allow rules
  });
  for (const mode of ["default", "manual", "auto", "acceptEdits"] as const) {
    test(`${mode} → elicit command fallback, elicit file edits`, () => {
      const p = mirror(settings(), mode);
      expect(p.commandFallback).toBe("elicit");
      expect(p.fileChange).toBe("elicit");
    });
  }
});

describe("mirror — mode → scope (workspaceWrite only for the auto-write modes)", () => {
  // Auto-write modes → :workspace (writes run without a prompt, matching Claude).
  for (const mode of ["acceptEdits", "auto"] as const) {
    test(`${mode} → :workspace (sandbox on OR off)`, () => {
      expect(mirror(settings(), mode).profile!.base).toBe(":workspace");
      expect(mirror(settings({ sandboxEnabled: true }), mode).profile!.base).toBe(":workspace");
    });
  }

  // Ask / no-auto-write modes → :read-only (a write escalates or is denied — never
  // more permissive than Claude, which prompts/blocks writes in these modes).
  for (const mode of ["plan", "default", "manual", "dontAsk"] as const) {
    test(`${mode} → :read-only (writes escalate or are denied)`, () => {
      expect(mirror(settings(), mode).profile!.base).toBe(":read-only");
      expect(mirror(settings({ sandboxEnabled: true }), mode).profile!.base).toBe(":read-only");
    });
  }

  // Only bypassPermissions → no profile → danger-full-access (full access, no sandbox).
  test("bypassPermissions → no profile (danger-full-access), regardless of sandbox", () => {
    expect(mirror(settings(), "bypassPermissions").profile).toBeUndefined();
    expect(mirror(settings({ sandboxEnabled: true }), "bypassPermissions").profile).toBeUndefined();
  });
});

describe("mirror — mode → collaborationMode (Codex's native plan posture)", () => {
  // plan selects Codex's own plan mode (the model refuses writes at the source —
  // verified to reproduce Claude plan). The required settings.model is filled at the
  // thread edge from the resolved thread, so mirror only decides the mode here.
  test("plan → collaborationMode 'plan'", () => {
    expect(mirror(settings(), "plan").collaborationMode).toBe("plan");
  });
  for (const mode of ["default", "manual", "acceptEdits", "auto", "dontAsk", "bypassPermissions"] as const) {
    test(`${mode} → no collaborationMode`, () => {
      expect(mirror(settings(), mode).collaborationMode).toBeUndefined();
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
  test("scope: auto-write modes→workspace, ask modes→read-only, bypass→none", () => {
    expect(profileFor(settings(), "acceptEdits")!.base).toBe(":workspace");
    expect(profileFor(settings(), "auto")!.base).toBe(":workspace");
    expect(profileFor(settings(), "default")!.base).toBe(":read-only"); // Manual asks for writes
    expect(profileFor(settings(), "plan")!.base).toBe(":read-only");
    expect(profileFor(settings(), "bypassPermissions")).toBeUndefined(); // danger
  });

  test("profile id is derived from the base scope", () => {
    expect(profileFor(settings(), "plan")!.id).toBe("dragoman-read-only");
    expect(profileFor(settings(), "auto")!.id).toBe("dragoman-workspace");
  });

  test("network mirrors Claude: enabled when unsandboxed, domains from allow/deny + WebFetch", () => {
    const p = profileFor(settings({ sandboxEnabled: true, allowedDomains: ["a.com"], deniedDomains: ["b.com"], allow: ["WebFetch(domain:c.com)"] }), "default");
    expect(p!.network).toEqual({ enabled: true, domains: [["a.com", "allow"], ["c.com", "allow"], ["b.com", "deny"]] });
  });

  test("bypassPermissions → no profile (danger-full-access; network open by nature)", () => {
    expect(profileFor(settings(), "bypassPermissions")).toBeUndefined();
  });

  test("profileFor derives the network domain list from the composite settings", () => {
    const p = profileFor(settings({ sandboxEnabled: true, allowedDomains: ["a.com"] }), "acceptEdits");
    expect(p!.network!.domains).toEqual([["a.com", "allow"]]);
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

  test("profileFor carries the filesystem axis", () => {
    const p = profileFor(settings({ sandboxEnabled: true, denyRead: ["/s"] }), "default");
    expect(p!.filesystem!.paths).toEqual([["/s", "deny"]]);
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
