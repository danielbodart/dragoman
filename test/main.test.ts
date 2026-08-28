import { describe, expect, test } from "bun:test";
import { parseArguments } from "../src/main.ts";

describe("parseArguments", () => {
  test("defaults to the serve command and the standard control socket", () => {
    const parsed = parseArguments([], {});
    expect(parsed.command).toBe("serve");
    expect(parsed.codexSocket).toMatch(/\.codex\/app-server-control\/app-server-control\.sock$/);
    expect(parsed.help).toBe(false);
    expect(parsed.showVersion).toBe(false);
  });

  test("CODEX_APP_SERVER_SOCKET overrides the default socket", () => {
    expect(parseArguments([], { CODEX_APP_SERVER_SOCKET: "/tmp/cx.sock" }).codexSocket).toBe("/tmp/cx.sock");
  });

  test("--codex-socket beats the env override", () => {
    const parsed = parseArguments(["--codex-socket", "/run/flag.sock"], { CODEX_APP_SERVER_SOCKET: "/tmp/env.sock" });
    expect(parsed.codexSocket).toBe("/run/flag.sock");
  });

  test("--version and --help are recognised", () => {
    expect(parseArguments(["--version"], {}).showVersion).toBe(true);
    expect(parseArguments(["-h"], {}).help).toBe(true);
  });

  test("a bare word is taken as the command", () => {
    expect(parseArguments(["serve"], {}).command).toBe("serve");
  });

  test("an unknown option is rejected", () => {
    expect(() => parseArguments(["--nope"], {})).toThrow(/unknown option/);
  });

  test("a flag missing its value is rejected", () => {
    expect(() => parseArguments(["--codex-socket"], {})).toThrow(/needs a value/);
  });
});
