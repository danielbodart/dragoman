// Command dragoman is a local bridge making OpenAI Codex a native-feeling
// subagent in Claude Code: a stdio MCP server that drives `codex
// app-server`, mirroring Claude's permission mode and settings onto every
// run, and putting Codex's approvals in front of the human as Claude Code's
// own prompts.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/danielbodart/dragoman/internal/app"
	dragomanhook "github.com/danielbodart/dragoman/internal/hook"
	"github.com/danielbodart/dragoman/internal/version"
	"github.com/danielbodart/gokit/environ"
)

const usage = `dragoman - a local bridge making OpenAI Codex a native-feeling subagent in Claude Code

Usage: dragoman [options] [command]

Commands:
  serve          Run as a stdio MCP server for Claude Code (default)
  hook posture   The PreToolUse hook: record Claude's live permission mode
  hook check     The SessionStart hook: warn when codex is not on PATH
  version        Show the version

Options:
      --codex-command CMD   Codex app-server command to spawn
                            (default "codex app-server")
      --version             Show the version and exit
  -h, --help                Show this message
`

func main() {
	os.Exit(run(os.Args[1:], environ.Current(), os.Stdin, os.Stdout, os.Stderr))
}

// parsed is a command line.
type parsed struct {
	command      string
	codexCommand []string
	help         bool
	showVersion  bool
	args         []string
}

// parseArguments reads the command line. DRAGOMAN_CODEX_COMMAND overrides
// the default codex command, and --codex-command overrides that. The flags
// are Dragoman's, so they are read strictly: an unknown one, or one missing
// its value, is an error naming it.
func parseArguments(args []string, env environ.Env) (parsed, error) {
	p := parsed{command: "serve", codexCommand: app.DefaultCodexCommand}
	if v := env["DRAGOMAN_CODEX_COMMAND"]; v != "" {
		p.codexCommand = strings.Split(v, " ")
	}
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch a {
		case "--codex-command":
			if i+1 >= len(args) {
				return p, fmt.Errorf("%s needs a value", a)
			}
			i++
			p.codexCommand = strings.Split(args[i], " ")
		case "--version":
			p.showVersion = true
		case "-h", "--help":
			p.help = true
		default:
			if strings.HasPrefix(a, "-") {
				return p, fmt.Errorf("unknown option '%s'", a)
			}
			if p.command == "hook" && p.args == nil {
				p.args = args[i:]
				return p, nil
			}
			p.command = a
		}
	}
	return p, nil
}

func run(args []string, env environ.Env, stdin io.Reader, stdout, stderr io.Writer) int {
	p, err := parseArguments(args, env)
	if err != nil {
		fmt.Fprintf(stderr, "Error: %s\n\n%s", err, usage)
		return 2
	}
	switch {
	case p.showVersion || p.command == "version":
		fmt.Fprintln(stdout, version.Version)
		return 0
	case p.help:
		fmt.Fprint(stdout, usage)
		return 0
	case p.command == "hook":
		return hook(p.args, env, stdin, stdout, stderr)
	case p.command != "serve":
		fmt.Fprintf(stderr, "Error: '%s' is not a command\n\n%s", p.command, usage)
		return 2
	}
	if err := serve(p, env, stdin, stdout); err != nil {
		fmt.Fprintln(stderr, "Error:", err)
		return 1
	}
	return 0
}

// hook runs a Claude Code hook. A hook never fails the tool call it rides,
// so even an unknown one exits 0, saying so on stderr.
func hook(args []string, env environ.Env, stdin io.Reader, stdout, stderr io.Writer) int {
	name := ""
	if len(args) > 0 {
		name = args[0]
	}
	switch name {
	case "posture":
		dragomanhook.Posture(stdin, env)
	case "check":
		dragomanhook.Check(stdin, stdout, dragomanhook.LookPath)
	default:
		fmt.Fprintf(stderr, "dragoman: no hook '%s' (posture, check)\n", name)
	}
	return 0
}

// serve runs the MCP server until Claude Code closes the pipe, or signals.
// Handling a signal overrides its default (terminate), so the handler exits
// explicitly: without it the process would survive the SIGTERM Claude Code
// sends when it stops the server, which is how stray servers accumulated.
func serve(p parsed, env environ.Env, stdin io.Reader, stdout io.Writer) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := &app.Container{Env: env, CodexCommand: p.codexCommand}
	if err := c.Wire(ctx); err != nil {
		return err
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-signals
		cancel()
		c.Runs.CloseAll()
		os.Exit(0)
	}()
	c.Log.Error(c.Banner(version.Version))
	err := c.Server.Serve(ctx, stdin, stdout)
	c.Runs.CloseAll()
	if errors.Is(err, io.EOF) {
		return nil
	}
	return err
}
