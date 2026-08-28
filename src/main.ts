import { version } from "./version.ts";

const USAGE = `dragoman - a local bridge making OpenAI Codex a native-feeling subagent in Claude Code

Usage: dragoman [options] [command]

Commands:
  serve     Run as a stdio MCP server for Claude Code (default)

Options:
      --version   Show the version and exit
  -h, --help      Show this message
`;

interface Parsed {
  readonly command: string;
  readonly help: boolean;
  readonly showVersion: boolean;
}

export function parseArguments(argv: readonly string[], _env: Record<string, string | undefined> = {}): Parsed {
  let command = "serve";
  let help = false;
  let showVersion = false;

  const rest = [...argv];
  while (rest.length > 0) {
    const argument = rest.shift()!;
    switch (argument) {
      case "--version": showVersion = true; break;
      case "-h": case "--help": help = true; break;
      default:
        if (argument.startsWith("-")) throw new Error(`unknown option '${argument}'`);
        command = argument;
    }
  }

  return { command, help, showVersion };
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

  switch (parsed.command) {
    case "serve":
      // Wired up in the next build steps (codex conn, mcp server, pump).
      console.error("Error: `serve` is not implemented yet\n");
      return 1;

    default:
      console.error(`Error: '${parsed.command}' is not a command\n`);
      console.error(USAGE);
      return 2;
  }
}

if (import.meta.main) {
  main(Bun.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: Error) => {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    });
}
