import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AppServerProcess } from "./codex.ts";
import { codexHomeLayout, ensureCodexHome } from "./codex-home.ts";
import { renderRules } from "./codex-config.ts";
import { McpElicitationChannel } from "./elicitation.ts";
import { buildServer, serve } from "./mcp.ts";
import { startPump } from "./pump.ts";
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
  // PER-RUN SPAWN (docs/DESIGN.md): every codex_run provisions its OWN
  // codex app-server, whose config is compiled from the settings read at that
  // moment, against a UNIQUE isolated CODEX_HOME (so concurrent runs never clobber
  // one config.toml). Codex is untouched until the first run, keeping the MCP
  // server responsive to initialize/tools/list and letting a broken codex fail
  // only a codex_run call. This is the provision seam — the only place that
  // touches the filesystem or spawns a process.
  const controller = new AbortController();
  const { realHome, sharedStore } = codexHomeLayout();
  const runsRoot = join(homedir(), ".dragoman", "runs");

  const runs = new ThreadRuns(
    async (policy) => {
      // One throwaway home per run, carrying just this run's compiled profile
      // (none → danger-full-access). Inherits the user's auth/config, never
      // touches the real ~/.codex.
      const runDir = join(runsRoot, crypto.randomUUID());
      // Claude's allow/deny Bash rules ride an execpolicy `.rules` file (config-layer
      // enforcement, binds for every command incl. auto/bypass); the profile carries
      // scope + fs + network. Both are compiled from the composite by `mirror`.
      const rules = renderRules(policy.execpolicyAmendments, policy.denyPrefixes);
      const home = ensureCodexHome(
        policy.profile ? [policy.profile] : [],
        { realHome, isolatedHome: join(runDir, "codex-home"), sharedStore },
        rules,
      );
      const conn = await AppServerProcess.start(parsed.codexCommand, { CODEX_HOME: home });
      return {
        conn,
        cleanup: () => {
          conn.close();
          rmSync(runDir, { recursive: true, force: true });
        },
      };
    },
    (conn) => {
      // Wire the pump onto this run's connection. Not awaited (it runs for the
      // connection's life); a failure is logged, never an unhandled rejection.
      void startPump(conn, runs, elicitation, { signal: controller.signal }).catch((error: unknown) => {
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
      runs.closeAll();
      process.exit(0);
    });
  }

  console.error(`Dragoman ${version} — MCP server ready (Codex via \`${parsed.codexCommand.join(" ")}\`, per-run spawn)`);
  await serve(server); // returns when Claude Code closes the stdio pipe
  runs.closeAll();
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
