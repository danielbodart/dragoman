import { AppServerProcess } from "./codex.ts";
import { ensureCodexHome } from "./codex-home.ts";
import { McpElicitationChannel } from "./elicitation.ts";
import { buildServer, serve } from "./mcp.ts";
import { allProfiles } from "./mirror.ts";
import { startPump } from "./pump.ts";
import { readSettings } from "./settings.ts";
import { ThreadRuns } from "./thread-run.ts";
import { version } from "./version.ts";

const USAGE = `dragoman - a local bridge making OpenAI Codex a native-feeling subagent in Claude Code

Usage: dragoman [options] [command]

Commands:
  serve     Run as a stdio MCP server for Claude Code (default)

Options:
      --codex-command CMD   Codex app-server command to spawn
                            (default "codex app-server")
      --version             Show the version and exit
  -h, --help                Show this message
`;

interface Parsed {
  readonly command: string;
  readonly codexCommand: readonly string[];
  readonly help: boolean;
  readonly showVersion: boolean;
}

const DEFAULT_CODEX_COMMAND = ["codex", "app-server"];

export function parseArguments(argv: readonly string[], env: Record<string, string | undefined> = {}): Parsed {
  let command = "serve";
  let codexCommand = env.DRAGOMAN_CODEX_COMMAND ? env.DRAGOMAN_CODEX_COMMAND.split(" ") : DEFAULT_CODEX_COMMAND;
  let help = false;
  let showVersion = false;

  const rest = [...argv];
  while (rest.length > 0) {
    const argument = rest.shift()!;
    const value = () => {
      const next = rest.shift();
      if (next === undefined) throw new Error(`${argument} needs a value`);
      return next;
    };
    switch (argument) {
      case "--codex-command": codexCommand = value().split(" "); break;
      case "--version": showVersion = true; break;
      case "-h": case "--help": help = true; break;
      default:
        if (argument.startsWith("-")) throw new Error(`unknown option '${argument}'`);
        command = argument;
    }
  }

  return { command, codexCommand, help, showVersion };
}

export async function main(argv: readonly string[]): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArguments(argv, Bun.env);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}\n`);
    console.error(USAGE);
    return 2;
  }

  if (parsed.showVersion) {
    console.log(version);
    return 0;
  }
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  if (parsed.command !== "serve") {
    console.error(`Error: '${parsed.command}' is not a command\n`);
    console.error(USAGE);
    return 2;
  }

  // Everything below stdout is the MCP channel to Claude Code — diagnostics go
  // to stderr so they never corrupt the protocol on stdout.
  //
  // Codex is connected LAZILY: the MCP server must answer initialize/tools/list
  // immediately, and a missing/broken codex should fail only a codex_run call,
  // not the whole bridge. So ThreadRuns takes a connect thunk and spawns codex
  // on the first run; the pump is wired onto the connection when it appears.
  const controller = new AbortController();
  let conn: AppServerProcess | undefined;

  const runs = new ThreadRuns(
    // Spawn codex against Dragoman's ISOLATED CODEX_HOME, whose config carries the
    // mirrored permission profiles (scope + network) without touching the user's
    // real ~/.codex. Profiles are generated from the settings read here, at spawn.
    () => {
      const home = ensureCodexHome(allProfiles(readSettings()));
      return AppServerProcess.start(parsed.codexCommand, { CODEX_HOME: home });
    },
    (connected) => {
      conn = connected as AppServerProcess;
      // Wire the pump the moment the connection exists. Not awaited (it runs for
      // the connection's life); a failure is logged to stderr, never left as an
      // unhandled rejection that could take the MCP server down.
      void startPump(connected, runs, elicitation, { signal: controller.signal }).catch((error: unknown) => {
        console.error(`Dragoman pump stopped: ${(error as Error).message}`);
      });
    },
  );
  const server = buildServer(runs);
  const elicitation = new McpElicitationChannel(server);

  // Clean up AND exit on a termination signal. Registering a handler overrides
  // the default (terminate), so without the explicit exit the process would
  // survive the SIGTERM Claude Code sends when it stops/reconnects the server —
  // which is exactly how stray `dragoman serve` processes accumulated.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      controller.abort();
      conn?.close();
      process.exit(0);
    });
  }

  console.error(`Dragoman ${version} — MCP server ready (Codex via \`${parsed.codexCommand.join(" ")}\`, connected on first use)`);
  await serve(server); // returns when Claude Code closes the stdio pipe
  conn?.close();
  return 0;
}

if (import.meta.main) {
  main(Bun.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: Error) => {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    });
}
