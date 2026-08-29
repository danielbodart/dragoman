import { describe, expect, test } from "bun:test";
import {
  hasDefaultPermissions,
  renderManagedBlock,
  spliceManagedBlock,
  stripManagedBlock,
  withDefaultPermissions,
  type ManagedProfile,
} from "../src/codex-config.ts";

const profile: ManagedProfile = {
  id: "dragoman-workspace",
  base: ":workspace",
  network: { enabled: true, domains: [["example.com", "allow"], ["example.org", "deny"]] },
};

describe("renderManagedBlock", () => {
  test("emits the proxy toggle, profile, base and domain rules", () => {
    const block = renderManagedBlock([profile]);
    expect(block).toContain("[features.network_proxy]\nenabled = true");
    expect(block).toContain("[permissions.dragoman-workspace]\nextends = \":workspace\"");
    expect(block).toContain("[permissions.dragoman-workspace.network]\nenabled = true");
    expect(block).toContain('[permissions.dragoman-workspace.network.domains]\n"example.com" = "allow"\n"example.org" = "deny"');
  });

  test("no profiles ⇒ empty string (no block, no proxy switched on)", () => {
    expect(renderManagedBlock([])).toBe("");
  });

  test("a profile with network but no domains sets enabled and no domains table or proxy", () => {
    const block = renderManagedBlock([{ id: "dragoman-plan", base: ":read-only", network: { enabled: false, domains: [] } }]);
    expect(block).toContain("[permissions.dragoman-plan.network]\nenabled = false");
    expect(block).not.toContain("network.domains");
    expect(block).not.toContain("network_proxy"); // no domains ⇒ no proxy
  });

  test("the proxy is enabled only when some profile carries domain rules", () => {
    expect(renderManagedBlock([profile])).toContain("[features.network_proxy]\nenabled = true");
    expect(renderManagedBlock([{ id: "p", base: ":workspace", network: { enabled: true, domains: [] } }])).not.toContain("network_proxy");
  });

  test("is all [table] sections — no bare root key that would be absorbed by a preceding table", () => {
    // A bare `default_permissions` appended after a user's [table] would land
    // INSIDE that table; the block must contain only [table] headers + their keys.
    const block = renderManagedBlock([profile]);
    expect(block).not.toContain("default_permissions");
    for (const line of block.split("\n").slice(1, -1)) {
      // every non-blank content line is a [header] or lives under one (indented by belonging to the latest table)
      if (line.trim() === "") continue;
      expect(line.startsWith("[") || line.includes("=")).toBe(true);
    }
  });
});

describe("renderManagedBlock — filesystem axis", () => {
  const withFs = (fs: ManagedProfile["filesystem"]): ManagedProfile => ({ id: "dragoman-workspace", base: ":workspace", filesystem: fs });

  test("emits the top-level path map and the :workspace_roots sub-table", () => {
    const block = renderManagedBlock([withFs({
      paths: [["/a/secret", "deny"], ["/b/out", "write"]],
      workspaceRoots: [["**/*.env", "deny"], [".", "write"]],
    })]);
    expect(block).toContain('[permissions.dragoman-workspace.filesystem]\n"/a/secret" = "deny"\n"/b/out" = "write"');
    expect(block).toContain('[permissions.dragoman-workspace.filesystem.":workspace_roots"]\n"**/*.env" = "deny"\n"." = "write"');
  });

  test("glob_scan_max_depth leads the table, before the :workspace_roots header", () => {
    const block = renderManagedBlock([withFs({ paths: [], workspaceRoots: [["**/*.env", "deny"]], globScanMaxDepth: 3 })]);
    const depthAt = block.indexOf("glob_scan_max_depth = 3");
    const subAt = block.indexOf('.filesystem.":workspace_roots"');
    expect(depthAt).toBeGreaterThan(-1);
    expect(depthAt).toBeLessThan(subAt); // parent-table key must precede the sub-table header
  });

  test("an empty axis renders no filesystem table at all", () => {
    const block = renderManagedBlock([withFs({ paths: [], workspaceRoots: [] })]);
    expect(block).not.toContain("filesystem");
  });

  test("a bare glob_scan_max_depth with no rules is still nothing (depth alone is not a rule)", () => {
    const block = renderManagedBlock([withFs({ paths: [], workspaceRoots: [], globScanMaxDepth: 5 })]);
    expect(block).not.toContain("filesystem");
  });
});

describe("spliceManagedBlock / stripManagedBlock", () => {
  const userConfig = 'approval_policy = "on-request"\napprovals_reviewer = "auto_review"\n';

  test("appends the block to existing config, preserving the user's content", () => {
    const block = renderManagedBlock([profile]);
    const out = spliceManagedBlock(userConfig, block);
    expect(out).toContain('approval_policy = "on-request"');
    expect(out).toContain("DRAGOMAN MANAGED");
    expect(out.indexOf("approval_policy")).toBeLessThan(out.indexOf("DRAGOMAN"));
  });

  test("replaces an existing managed block rather than stacking a second one", () => {
    const first = spliceManagedBlock(userConfig, renderManagedBlock([profile]));
    const second = spliceManagedBlock(first, renderManagedBlock([{ ...profile, network: { enabled: true, domains: [["only.com", "allow"]] } }]));
    expect(second.match(/DRAGOMAN MANAGED \(do not edit/g)?.length).toBe(1); // exactly one block
    expect(second).toContain('"only.com" = "allow"');
    expect(second).not.toContain('"example.org" = "deny"');
    expect(second).toContain('approval_policy = "on-request"'); // user content survives
  });

  test("strip returns the config to exactly its pre-splice content", () => {
    const spliced = spliceManagedBlock(userConfig, renderManagedBlock([profile]));
    expect(stripManagedBlock(spliced).trim()).toBe(userConfig.trim());
  });

  test("strip is a no-op when there is no managed block", () => {
    expect(stripManagedBlock(userConfig)).toBe(userConfig);
  });

  test("splicing into empty config yields just the block", () => {
    const out = spliceManagedBlock("", renderManagedBlock([profile]));
    expect(out.startsWith("# >>> DRAGOMAN MANAGED")).toBe(true);
  });
});

describe("default_permissions handling", () => {
  test("hasDefaultPermissions detects a user's own value; the managed block never carries one", () => {
    expect(hasDefaultPermissions('default_permissions = ":danger-full-access"\n')).toBe(true);
    expect(hasDefaultPermissions('approval_policy = "on-request"\n')).toBe(false);
    const ours = spliceManagedBlock('approval_policy = "on-request"\n', renderManagedBlock([profile]));
    expect(hasDefaultPermissions(ours)).toBe(false);
  });

  test("withDefaultPermissions prepends a root key (before any table) when absent", () => {
    const config = spliceManagedBlock('approval_policy = "on-request"\n', renderManagedBlock([profile]));
    const out = withDefaultPermissions(config, ":workspace");
    expect(out.startsWith('default_permissions = ":workspace"\n')).toBe(true); // leads the file, before every [table]
    expect(out.match(/default_permissions/g)?.length).toBe(1);
  });

  test("withDefaultPermissions respects a value the user already set", () => {
    const config = 'default_permissions = ":danger-full-access"\napproval_policy = "on-request"\n';
    expect(withDefaultPermissions(config, ":workspace")).toBe(config);
  });
});
