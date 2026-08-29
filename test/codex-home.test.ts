import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCodexHome } from "../src/codex-home.ts";
import type { ManagedProfile } from "../src/codex-config.ts";

const profiles: ManagedProfile[] = [
  { id: "dragoman-workspace", base: ":workspace", domains: [["example.com", "allow"], ["example.org", "deny"]] },
];

let root: string;
let realHome: string;
let isolatedHome: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dragoman-home-"));
  realHome = join(root, "real");
  isolatedHome = join(root, "isolated");
  mkdirSync(realHome, { recursive: true });
  writeFileSync(join(realHome, "auth.json"), '{"token":"real"}');
  writeFileSync(join(realHome, "config.toml"), 'approval_policy = "on-request"\n');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("ensureCodexHome", () => {
  test("returns the isolated home and creates it", () => {
    const home = ensureCodexHome(profiles, { realHome, isolatedHome });
    expect(home).toBe(isolatedHome);
    expect(existsSync(isolatedHome)).toBe(true);
  });

  test("symlinks auth.json to the real home (real auth, isolated config)", () => {
    ensureCodexHome(profiles, { realHome, isolatedHome });
    const link = join(isolatedHome, "auth.json");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(realHome, "auth.json"));
    expect(readFileSync(link, "utf8")).toBe('{"token":"real"}');
  });

  test("writes config = user's config verbatim + the managed block", () => {
    ensureCodexHome(profiles, { realHome, isolatedHome });
    const config = readFileSync(join(isolatedHome, "config.toml"), "utf8");
    expect(config).toContain('approval_policy = "on-request"'); // user's own settings preserved
    expect(config).toContain("[features.network_proxy]\nenabled = true");
    expect(config).toContain('[permissions.dragoman-workspace.network.domains]\n"example.com" = "allow"\n"example.org" = "deny"');
    expect(config).toContain('default_permissions = ":workspace"'); // user had none → we set it
  });

  test("does NOT touch the user's real config.toml", () => {
    const before = readFileSync(join(realHome, "config.toml"), "utf8");
    ensureCodexHome(profiles, { realHome, isolatedHome });
    expect(readFileSync(join(realHome, "config.toml"), "utf8")).toBe(before);
  });

  test("respects a user's own default_permissions instead of forcing one", () => {
    writeFileSync(join(realHome, "config.toml"), 'default_permissions = ":danger-full-access"\n');
    ensureCodexHome(profiles, { realHome, isolatedHome });
    const config = readFileSync(join(isolatedHome, "config.toml"), "utf8");
    expect(config).toContain('default_permissions = ":danger-full-access"');
    // our block must not add a competing default_permissions
    expect(config.match(/default_permissions/g)?.length).toBe(1);
  });

  test("is idempotent: a second call refreshes rather than stacking blocks", () => {
    ensureCodexHome(profiles, { realHome, isolatedHome });
    ensureCodexHome([{ id: "dragoman-workspace", base: ":workspace", domains: [["only.com", "allow"]] }], { realHome, isolatedHome });
    const config = readFileSync(join(isolatedHome, "config.toml"), "utf8");
    expect(config.match(/DRAGOMAN MANAGED \(do not edit/g)?.length).toBe(1);
    expect(config).toContain('"only.com" = "allow"');
    expect(config).not.toContain('"example.org" = "deny"');
  });

  test("works when the real home has no config.toml yet", () => {
    rmSync(join(realHome, "config.toml"));
    ensureCodexHome(profiles, { realHome, isolatedHome });
    const config = readFileSync(join(isolatedHome, "config.toml"), "utf8");
    expect(config).toContain("DRAGOMAN MANAGED");
  });
});
