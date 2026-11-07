//go:build integration

package integration

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/danielbodart/dragoman/internal/app"
	"github.com/danielbodart/dragoman/internal/codex"
	"github.com/danielbodart/dragoman/internal/codexhome"
	"github.com/danielbodart/dragoman/internal/posture"
	"github.com/danielbodart/dragoman/internal/protocol"
	"github.com/danielbodart/dragoman/internal/run"
	"github.com/danielbodart/gokit/environ"
	"github.com/danielbodart/gokit/logx"
)

func realCodexHome(t *testing.T) string {
	if v := os.Getenv("CODEX_HOME"); v != "" {
		return v
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Join(home, ".codex")
}

// withCodex runs fn against a fresh, initialized app-server, always closing
// it.
func withCodex(t *testing.T, env map[string]string, fn func(conn codex.Conn)) {
	t.Helper()
	conn, err := codex.Start(context.Background(), codexCommand(), env)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	fn(conn)
}

// execute runs one command in the sandbox: no thread, turn or model.
func execute(t *testing.T, conn codex.Conn, params protocol.CommandExecParams) protocol.CommandExecResponse {
	t.Helper()
	raw, err := conn.Request(context.Background(), "command/exec", params)
	if err != nil {
		t.Fatal(err)
	}
	var resp protocol.CommandExecResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		t.Fatal(err)
	}
	return resp
}

func execPolicy(t *testing.T, conn codex.Conn, command []string, cwd string, policy protocol.SandboxPolicy) protocol.CommandExecResponse {
	return execute(t, conn, protocol.CommandExecParams{Command: command, Cwd: &cwd, SandboxPolicy: &policy})
}

func execProfiled(t *testing.T, conn codex.Conn, command []string, cwd, profile string) protocol.CommandExecResponse {
	return execute(t, conn, protocol.CommandExecParams{Command: command, Cwd: &cwd, PermissionProfile: &profile})
}

// withProfiledCodex spawns codex against an isolated home carrying the one
// profile the mirror compiles for mode, the production provisioning, and
// runs fn with that profile's id.
func withProfiledCodex(t *testing.T, s posture.Effective, mode posture.Mode, fn func(conn codex.Conn, profile string)) {
	t.Helper()
	parent := tempDir(t)
	profile := posture.ProfileFor(s, mode)
	home, err := codexhome.Ensure([]codexhome.Profile{*profile}, codexhome.Layout{RealHome: realCodexHome(t), IsolatedHome: filepath.Join(parent, "codex-home")}, "")
	if err != nil {
		t.Fatal(err)
	}
	withCodex(t, map[string]string{"CODEX_HOME": home}, func(conn codex.Conn) { fn(conn, profile.ID) })
}

// profiledRuns is a registry wired exactly the production way, the
// container main runs: a unique home per run, deleted when it settles, and
// one shared store, which is what lets codex_continue resume after the
// run's home is gone.
func profiledRuns(t *testing.T, s posture.Effective, elicitation run.Elicitation) *run.Runs {
	t.Helper()
	env := environ.Current()
	delete(env, "DRAGOMAN_HOME")
	env["CODEX_HOME"] = realCodexHome(t)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	c := &app.Container{
		Env: env, Home: tempDir(t), Log: logx.Writers(os.Stderr, os.Stderr), CodexCommand: codexCommand(),
		Settings: func() posture.Effective { return s }, Elicitation: elicitation,
	}
	if err := c.Wire(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Runs.CloseAll)
	return c.Runs
}

// scripted answers every approval with one decision and records the asks:
// the evidence that an approval fired, or did not.
type scripted struct {
	decision string
	mu       sync.Mutex
	asks     []run.Approval
}

func (s *scripted) Ask(_ context.Context, a run.Approval) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.asks = append(s.asks, a)
	return s.decision, nil
}

func (s *scripted) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.asks)
}

// settle polls a run until it is terminal.
func settle(t *testing.T, runs *run.Runs, handle string) run.Record {
	t.Helper()
	deadline := time.Now().Add(150 * time.Second)
	for {
		rec, ok := runs.Status(handle)
		if ok && (rec.Status == run.Done || rec.Status == run.Failed) {
			return rec
		}
		if time.Now().After(deadline) {
			t.Fatalf("run %s did not settle (status %s)", handle, rec.Status)
		}
		time.Sleep(500 * time.Millisecond)
	}
}

// resultText is a settled run's last result or error.
func resultText(rec run.Record) string {
	for i := len(rec.Events) - 1; i >= 0; i-- {
		switch e := rec.Events[i]; e.Kind {
		case "result":
			if e.Text != nil {
				return *e.Text
			}
			return ""
		case "error":
			return e.Message
		}
	}
	return ""
}

// tempDir is a throwaway directory under $HOME, deliberately not /tmp:
// workspace-write keeps /tmp writable, so a /tmp directory would make
// "outside the workspace" probes falsely pass.
func tempDir(t *testing.T) string {
	t.Helper()
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp(home, ".dragoman-probe-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

func ptr[T any](v T) *T { return &v }
