package main

import (
	"slices"
	"strings"
	"testing"

	"github.com/danielbodart/gokit/environ"
)

func TestParseDefaultsToServeAndCodexAppServer(t *testing.T) {
	p, err := parseArguments(nil, environ.Env{})
	if err != nil || p.command != "serve" || !slices.Equal(p.codexCommand, []string{"codex", "app-server"}) || p.help || p.showVersion {
		t.Fatalf("got %+v, %v", p, err)
	}
}

func TestDragomanCodexCommandOverridesTheDefault(t *testing.T) {
	p, _ := parseArguments(nil, environ.Env{"DRAGOMAN_CODEX_COMMAND": "/opt/codex app-server"})
	if !slices.Equal(p.codexCommand, []string{"/opt/codex", "app-server"}) {
		t.Fatalf("got %v", p.codexCommand)
	}
}

func TestTheFlagBeatsTheEnvironment(t *testing.T) {
	p, _ := parseArguments([]string{"--codex-command", "mycodex app-server"}, environ.Env{"DRAGOMAN_CODEX_COMMAND": "codex app-server"})
	if !slices.Equal(p.codexCommand, []string{"mycodex", "app-server"}) {
		t.Fatalf("got %v", p.codexCommand)
	}
}

func TestVersionAndHelpAreRecognised(t *testing.T) {
	if p, _ := parseArguments([]string{"--version"}, environ.Env{}); !p.showVersion {
		t.Fatal("--version")
	}
	if p, _ := parseArguments([]string{"-h"}, environ.Env{}); !p.help {
		t.Fatal("-h")
	}
}

func TestABareWordIsTheCommand(t *testing.T) {
	if p, _ := parseArguments([]string{"serve"}, environ.Env{}); p.command != "serve" {
		t.Fatalf("got %q", p.command)
	}
}

func TestAnUnknownOptionIsRejected(t *testing.T) {
	if _, err := parseArguments([]string{"--nope"}, environ.Env{}); err == nil || !strings.Contains(err.Error(), "unknown option") {
		t.Fatalf("got %v", err)
	}
}

func TestAFlagMissingItsValueIsRejected(t *testing.T) {
	if _, err := parseArguments([]string{"--codex-command"}, environ.Env{}); err == nil || !strings.Contains(err.Error(), "needs a value") {
		t.Fatalf("got %v", err)
	}
}

func TestAnUnknownCommandExitsTwo(t *testing.T) {
	var out, errs strings.Builder
	if code := run([]string{"frobnicate"}, environ.Env{}, strings.NewReader(""), &out, &errs); code != 2 || !strings.Contains(errs.String(), "'frobnicate' is not a command") {
		t.Fatalf("got %d, %q", code, errs.String())
	}
}

func TestVersionPrintsTheVersion(t *testing.T) {
	var out, errs strings.Builder
	if code := run([]string{"--version"}, environ.Env{}, strings.NewReader(""), &out, &errs); code != 0 || strings.TrimSpace(out.String()) != "development" {
		t.Fatalf("got %d, %q", code, out.String())
	}
}
