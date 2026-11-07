// Package app wires Dragoman: the one object graph main runs.
package app

import (
	"context"
	"crypto/rand"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/danielbodart/dragoman/internal/codex"
	"github.com/danielbodart/dragoman/internal/codexhome"
	"github.com/danielbodart/dragoman/internal/diagnostics"
	"github.com/danielbodart/dragoman/internal/mcp"
	"github.com/danielbodart/dragoman/internal/posture"
	"github.com/danielbodart/dragoman/internal/run"
	"github.com/danielbodart/gokit/environ"
	"github.com/danielbodart/gokit/logx"
)

// DefaultCodexCommand is the app-server Dragoman spawns per run.
var DefaultCodexCommand = []string{"codex", "app-server"}

// Container is the object graph. Production wires it once; a test replaces
// leaves (Env, Home, Cwd, Log, Provision, Elicitation, Settings) before Wire,
// and everything downstream is derived from them.
type Container struct {
	Env          environ.Env
	Home         string
	Cwd          string
	Log          logx.Logger
	CodexCommand []string
	// Provision spawns a run's app-server; the per-run home and codex
	// unless a test replaces it.
	Provision run.Provision
	// Elicitation asks the human; the MCP server's unless replaced.
	Elicitation run.Elicitation
	// Settings reads Claude's settings; from disk unless replaced.
	Settings func() posture.Effective

	Dirs   posture.Dirs
	Runs   *run.Runs
	Pump   *run.Pump
	Server *mcp.Server
	Tools  *mcp.Tools
}

// Wire fills in the leaves left unset and derives the rest.
func (c *Container) Wire(ctx context.Context) error {
	if c.Env == nil {
		c.Env = environ.Current()
	}
	if c.Home == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		c.Home = home
	}
	if c.Cwd == "" {
		cwd, err := os.Getwd()
		if err != nil {
			return err
		}
		c.Cwd = cwd
	}
	if c.Log == nil {
		// stdout is the MCP channel, so everything said goes to stderr.
		c.Log = logx.Writers(os.Stderr, os.Stderr)
	}
	if c.CodexCommand == nil {
		c.CodexCommand = DefaultCodexCommand
	}
	c.Dirs = posture.DirsFrom(c.Env, c.Cwd, c.Home)
	if c.Settings == nil {
		dirs, log := c.Dirs, c.Log
		c.Settings = func() posture.Effective { return dirs.Read(log) }
	}
	if c.Provision == nil {
		c.Provision = c.provision
	}
	c.Pump = &run.Pump{Log: c.Log}
	c.Runs = run.New(c.Provision, func(conn codex.Conn) { c.Pump.Start(ctx, conn) }, nil, c.Settings, c.Log)
	c.Pump.Runs = c.Runs
	c.Tools = &mcp.Tools{
		Runs:      c.Runs,
		LiveMode:  func(id string) string { return posture.TakeLiveMode(id, c.Env) },
		ToolUseID: posture.ToolUseIDOf,
		Diagnostics: func() any {
			return diagnostics.Build(c.Runs, c.Env, c.Cwd, c.Dirs, c.Log)
		},
	}
	c.Server = mcp.NewServer(mcp.ToolsJSON, c.Tools.Call, c.Log)
	if c.Elicitation == nil {
		c.Elicitation = mcp.Elicitation{Server: c.Server}
	}
	c.Pump.Elicitation = c.Elicitation
	return nil
}

// provision gives a run its own home under ~/.dragoman/runs, carrying just
// the profile and rules compiled for it, and spawns codex against it. The
// home inherits the user's auth and config and never touches ~/.codex; the
// thread rollout lives in the shared store, so it outlives the home.
func (c *Container) provision(ctx context.Context, policy posture.Policy) (run.Provisioned, error) {
	layout := codexhome.LayoutFrom(c.Env, c.Home)
	runDir := filepath.Join(c.Home, ".dragoman", "runs", newID())
	layout.IsolatedHome = filepath.Join(runDir, "codex-home")
	var profiles []codexhome.Profile
	if policy.Profile != nil {
		profiles = []codexhome.Profile{*policy.Profile}
	}
	home, err := codexhome.Ensure(profiles, layout, codexhome.RenderRules(policy.ExecpolicyAmendments, policy.DenyPrefixes))
	if err != nil {
		_ = os.RemoveAll(runDir)
		return run.Provisioned{}, err
	}
	conn, err := codex.Start(ctx, c.CodexCommand, map[string]string{"CODEX_HOME": home})
	if err != nil {
		_ = os.RemoveAll(runDir)
		return run.Provisioned{}, err
	}
	return run.Provisioned{Conn: conn, Cleanup: func() {
		_ = conn.Close()
		_ = os.RemoveAll(runDir)
	}}, nil
}

// Banner is the line said on start.
func (c *Container) Banner(v string) string {
	return fmt.Sprintf("Dragoman %s — MCP server ready (Codex via `%s`, per-run spawn)", v, strings.Join(c.CodexCommand, " "))
}

// newID is a random UUID (v4), a run directory's name.
func newID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
