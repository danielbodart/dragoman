import { homedir } from "node:os";
import { join } from "node:path";
import { SocketAppServerConn } from "./codex.ts";
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
      --codex-socket PATH   Codex app-server control socket
                            (default ~/.codex/app-server-control/app-server-control.sock)
      --version             Show the version and exit
  -h, --help                Show this message
`;

interface Parsed {
  readonly command: string;
  readonly codexSocket: string;
  readonly help: boolean;
  readonly showVersion: boolean;
}

const DEFAULT_SOCKET = join(homedir(), ".codex", "app-server-control", "app-server-control.sock");

export function parseArguments(argv: readonly string[], env: Record<string, string | undefined> = {}): Parsed {
  let command = "serve";
  let codexSocket = env.CODEX_APP_SERVER_SOCKET ?? DEFAULT_SOCKET;
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
      case "--codex-socket": codexSocket = value(); break;
      case "--version": showVersion = true; break;
      case "-h": case "--help": help = true; break;
      default:
        if (argument.startsWith("-")) throw new Error(`unknown option '${argument}'`);
        command = argument;
    }
  }

  return { command, codexSocket, help, showVersion };
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
  if (!(await Bun.file(parsed.codexSocket).exists())) {
    console.error(
      `Error: no Codex app-server control socket at ${parsed.codexSocket}.\n` +
        `Start the daemon first: codex app-server daemon start`,
    );
    return 1;
  }

  const conn = await SocketAppServerConn.connect(parsed.codexSocket);
  const runs = new ThreadRuns(conn);
  const server = buildServer(runs);
  const elicitation = new McpElicitationChannel(server);

  const controller = new AbortController();
  startPump(conn, runs, elicitation, { signal: controller.signal });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      controller.abort();
      conn.close();
    });
  }

  console.error(`Dragoman ${version} — bridging Codex at ${parsed.codexSocket}`);
  await serve(server); // returns when Claude Code closes the stdio pipe
  conn.close();
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
