import { describe, expect, test } from "bun:test";
import { mergeSettings, locateSettings, type ClaudeSettings } from "../src/settings.ts";

describe("mergeSettings", () => {
  test("unions permission arrays across layers, de-duplicated", () => {
    const user: ClaudeSettings = { permissions: { allow: ["Bash(ls)", "Read(/a)"] } };
    const project: ClaudeSettings = { permissions: { allow: ["Bash(ls)", "Bash(git status)"] } };
    const merged = mergeSettings([user, project]);
    expect(merged.allow).toEqual(["Bash(ls)", "Read(/a)", "Bash(git status)"]);
  });

  test("scalars take the highest-precedence (last) layer that sets them", () => {
    const user: ClaudeSettings = { permissions: { defaultMode: "default" } };
    const projectLocal: ClaudeSettings = { permissions: { defaultMode: "plan" } };
    expect(mergeSettings([user, projectLocal]).defaultMode).toBe("plan");
  });

  test("a layer that doesn't set a scalar doesn't clobber a lower layer's value", () => {
    const user: ClaudeSettings = { permissions: { defaultMode: "acceptEdits" } };
    const project: ClaudeSettings = { permissions: { allow: ["Bash(ls)"] } }; // no defaultMode
    expect(mergeSettings([user, project]).defaultMode).toBe("acceptEdits");
  });

  test("unions sandbox filesystem and network arrays too", () => {
    const a: ClaudeSettings = { sandbox: { filesystem: { denyRead: ["/etc"] }, network: { allowedDomains: ["a.com"] } } };
    const b: ClaudeSettings = { sandbox: { filesystem: { denyRead: ["/root"] }, network: { allowedDomains: ["b.com"] } } };
    const merged = mergeSettings([a, b]);
    expect(merged.denyRead).toEqual(["/etc", "/root"]);
    expect(merged.allowedDomains).toEqual(["a.com", "b.com"]);
  });

  test("empty input yields empty arrays and undefined scalars", () => {
    const merged = mergeSettings([]);
    expect(merged.allow).toEqual([]);
    expect(merged.defaultMode).toBeUndefined();
    expect(merged.sandboxEnabled).toBeUndefined();
  });
});

describe("locateSettings", () => {
  test("anchors project files on CLAUDE_PROJECT_DIR and config files on CLAUDE_CONFIG_DIR", () => {
    const paths = locateSettings({ CLAUDE_PROJECT_DIR: "/proj", CLAUDE_CONFIG_DIR: "/cfg" });
    expect(paths).toEqual([
      "/cfg/settings.json",
      "/cfg/settings.local.json",
      "/proj/.claude/settings.json",
      "/proj/.claude/settings.local.json",
    ]);
  });

  test("orders low→high precedence: user, user-local, project, project-local", () => {
    const paths = locateSettings({ CLAUDE_PROJECT_DIR: "/proj", CLAUDE_CONFIG_DIR: "/cfg" });
    expect(paths[0]).toContain("/cfg/settings.json");
    expect(paths[3]).toContain("/proj/.claude/settings.local.json");
  });
});
