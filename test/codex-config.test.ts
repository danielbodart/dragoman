import { describe, expect, test } from "bun:test";
import {
  hasDefaultPermissions,
  renderManagedBlock,
  spliceManagedBlock,
  stripManagedBlock,
  type ManagedProfile,
} from "../src/codex-config.ts";

const profile: ManagedProfile = {
  id: "dragoman-workspace",
  base: ":workspace",
  domains: [["example.com", "allow"], ["example.org", "deny"]],
};

describe("renderManagedBlock", () => {
  test("emits the proxy toggle, profile, base and domain rules", () => {
    const block = renderManagedBlock([profile], { defaultPermissions: ":workspace" });
    expect(block).toContain("[features.network_proxy]\nenabled = true");
    expect(block).toContain('default_permissions = ":workspace"');
    expect(block).toContain("[permissions.dragoman-workspace]\nextends = \":workspace\"");
    expect(block).toContain("[permissions.dragoman-workspace.network]\nenabled = true");
    expect(block).toContain('[permissions.dragoman-workspace.network.domains]\n"example.com" = "allow"\n"example.org" = "deny"');
  });

  test("a profile with no domains still enables its network but writes no domains table", () => {
    const block = renderManagedBlock([{ id: "dragoman-plan", base: ":read-only", domains: [] }]);
    expect(block).toContain("[permissions.dragoman-plan.network]\nenabled = true");
    expect(block).not.toContain("network.domains");
  });

  test("omits default_permissions when not requested", () => {
    expect(renderManagedBlock([profile])).not.toContain("default_permissions");
  });
});

describe("spliceManagedBlock / stripManagedBlock", () => {
  const userConfig = 'approval_policy = "on-request"\napprovals_reviewer = "auto_review"\n';

  test("appends the block to existing config, preserving the user's content", () => {
    const block = renderManagedBlock([profile], { defaultPermissions: ":workspace" });
    const out = spliceManagedBlock(userConfig, block);
    expect(out).toContain('approval_policy = "on-request"');
    expect(out).toContain("DRAGOMAN MANAGED");
    expect(out.indexOf("approval_policy")).toBeLessThan(out.indexOf("DRAGOMAN"));
  });

  test("replaces an existing managed block rather than stacking a second one", () => {
    const first = spliceManagedBlock(userConfig, renderManagedBlock([profile], { defaultPermissions: ":workspace" }));
    const second = spliceManagedBlock(first, renderManagedBlock([{ ...profile, domains: [["only.com", "allow"]] }]));
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

describe("hasDefaultPermissions", () => {
  test("detects a user's own default_permissions, ignoring our managed block", () => {
    expect(hasDefaultPermissions('default_permissions = ":danger-full-access"\n')).toBe(true);
    expect(hasDefaultPermissions('approval_policy = "on-request"\n')).toBe(false);
    // our block's default_permissions must NOT count as the user's own
    const ours = spliceManagedBlock('approval_policy = "on-request"\n', renderManagedBlock([profile], { defaultPermissions: ":workspace" }));
    expect(hasDefaultPermissions(ours)).toBe(false);
  });
});
