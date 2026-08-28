import { describe, expect, test } from "bun:test";
import { parseArguments } from "../src/main.ts";

describe("parseArguments", () => {
  test("defaults to the serve command and the `codex app-server` command", () => {
    const parsed = parseArguments([], {});
    expect(parsed.command).toBe("serve");
    expect(parsed.codexCommand).toEqual(["codex", "app-server"]);
    expect(parsed.help).toBe(false);
    expect(parsed.showVersion).toBe(false);
  });

  test("DRAGOMAN_CODEX_COMMAND overrides the default command", () => {
    expect(parseArguments([], { DRAGOMAN_CODEX_COMMAND: "/opt/codex app-server" }).codexCommand).toEqual(["/opt/codex", "app-server"]);
  });

  test("--codex-command beats the env override", () => {
    const parsed = parseArguments(["--codex-command", "mycodex app-server"], { DRAGOMAN_CODEX_COMMAND: "codex app-server" });
    expect(parsed.codexCommand).toEqual(["mycodex", "app-server"]);
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
    expect(() => parseArguments(["--codex-command"], {})).toThrow(/needs a value/);
  });
});
