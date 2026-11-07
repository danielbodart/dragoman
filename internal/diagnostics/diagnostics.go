// Package diagnostics is Dragoman's runtime probe, the `diagnostics` tool:
// what the bridge sees (working directory, Claude Code's environment, the
// reachable settings files, what they would mirror onto Codex per posture)
// and what it is doing (the live runs, their status, turn and latest event).
//
// It reports settings files' presence and the shape of their permission and
// sandbox keys, never their contents, so nothing sensitive lands in the
// transcript.
package diagnostics

import (
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"os"

	"github.com/danielbodart/dragoman/internal/posture"
	"github.com/danielbodart/dragoman/internal/protocol"
	"github.com/danielbodart/dragoman/internal/run"
	"github.com/danielbodart/dragoman/internal/version"
	"github.com/danielbodart/gokit/environ"
	"github.com/danielbodart/gokit/logx"
)

// ActiveRun is one live or recently settled run.
type ActiveRun struct {
	Handle string     `json:"handle"`
	Status string     `json:"status"`
	TurnID *string    `json:"turnId"`
	Ctx    *int       `json:"ctx"`
	Latest *run.Event `json:"latest"`
}

// SettingsFile is a settings file's presence and shape: keys and counts.
type SettingsFile struct {
	Label       string              `json:"label"`
	Path        string              `json:"path"`
	Present     bool                `json:"present"`
	Keys        []string            `json:"keys,omitempty"`
	Permissions *PermissionsSummary `json:"permissions,omitempty"`
	Sandbox     *SandboxSummary     `json:"sandbox,omitempty"`
	Error       string              `json:"error,omitempty"`
}

// PermissionsSummary is the permissions block as counts.
type PermissionsSummary struct {
	DefaultMode           *string `json:"defaultMode,omitempty"`
	Allow                 *int    `json:"allow,omitempty"`
	Deny                  *int    `json:"deny,omitempty"`
	Ask                   *int    `json:"ask,omitempty"`
	AdditionalDirectories *int    `json:"additionalDirectories,omitempty"`
}

// SandboxSummary is the sandbox block's keys and enabled flag.
type SandboxSummary struct {
	Enabled    *bool    `json:"enabled,omitempty"`
	Filesystem []string `json:"filesystem,omitempty"`
	Network    []string `json:"network,omitempty"`
}

// MirrorPosture is one posture's mirrored policy.
type MirrorPosture struct {
	Posture              *string                 `json:"posture"`
	Mode                 string                  `json:"mode"`
	ApprovalPolicy       protocol.AskForApproval `json:"approvalPolicy"`
	Profile              *string                 `json:"profile"`
	ExecpolicyAmendments [][]string              `json:"execpolicyAmendments,omitempty"`
}

// Effective is the merged settings, as counts.
type Effective struct {
	DefaultMode           *string  `json:"defaultMode"`
	Allow                 int      `json:"allow"`
	Deny                  int      `json:"deny"`
	AdditionalDirectories []string `json:"additionalDirectories"`
	SandboxEnabled        bool     `json:"sandboxEnabled"`
	AllowedDomains        int      `json:"allowedDomains"`
}

// Mirror is what the settings would mirror onto Codex right now.
type Mirror struct {
	Effective Effective       `json:"effective"`
	Postures  []MirrorPosture `json:"postures"`
}

// Report is the whole probe.
type Report struct {
	Version       string             `json:"version"`
	ActiveRuns    []ActiveRun        `json:"activeRuns"`
	RateLimits    run.Usage          `json:"rateLimits"`
	Cwd           string             `json:"cwd"`
	Env           map[string]*string `json:"env"`
	ProjectDir    string             `json:"projectDir"`
	ConfigDir     string             `json:"configDir"`
	SettingsFiles []SettingsFile     `json:"settingsFiles"`
	LiveModeDir   string             `json:"liveModeDir"`
	Mirror        Mirror             `json:"mirror"`
}

// envNames are the Claude Code variables the bridge cares about.
var envNames = []string{
	"CLAUDE_PROJECT_DIR", "CLAUDE_CONFIG_DIR", "CLAUDE_PLUGIN_ROOT", "CLAUDECODE",
	"CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MCP_SERVER_NAME", "PWD",
}

// Build builds the probe. runs may be nil.
func Build(runs *run.Runs, env environ.Env, cwd string, dirs posture.Dirs, log logx.Logger) Report {
	settings := dirs.Read(log)
	envSnapshot := map[string]*string{}
	for _, name := range envNames {
		if v, ok := env[name]; ok {
			envSnapshot[name] = &v
		} else {
			envSnapshot[name] = nil
		}
	}
	r := Report{
		Version:       version.Version,
		ActiveRuns:    activeRuns(runs),
		Cwd:           cwd,
		Env:           envSnapshot,
		ProjectDir:    dirs.Project,
		ConfigDir:     dirs.Config,
		SettingsFiles: settingsFiles(dirs),
		LiveModeDir:   posture.LiveModeDir(env),
		Mirror: Mirror{Effective: Effective{
			DefaultMode:           settings.DefaultMode,
			Allow:                 len(settings.Allow),
			Deny:                  len(settings.Deny),
			AdditionalDirectories: orEmpty(settings.AdditionalDirectories),
			SandboxEnabled:        settings.SandboxEnabled != nil && *settings.SandboxEnabled,
			AllowedDomains:        len(settings.AllowedDomains),
		}},
	}
	if runs != nil {
		r.RateLimits = runs.AccountLimits()
	}
	for _, p := range []string{"", "plan", "bypassPermissions"} {
		mode, _ := posture.ResolveMode(settings, p)
		policy := posture.Mirror(settings, mode)
		mp := MirrorPosture{Mode: string(mode), ApprovalPolicy: policy.ApprovalPolicy}
		if p != "" {
			v := p
			mp.Posture = &v
		}
		if policy.Profile != nil {
			id := policy.Profile.ID
			mp.Profile = &id
		}
		if len(policy.ExecpolicyAmendments) > 0 {
			mp.ExecpolicyAmendments = policy.ExecpolicyAmendments
		}
		r.Mirror.Postures = append(r.Mirror.Postures, mp)
	}
	return r
}

func orEmpty(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func activeRuns(runs *run.Runs) []ActiveRun {
	out := []ActiveRun{}
	if runs == nil {
		return out
	}
	for _, h := range runs.Handles() {
		rec, ok := runs.Status(h)
		if !ok {
			continue
		}
		a := ActiveRun{Handle: h, Status: string(rec.Status), Ctx: rec.Ctx}
		if rec.TurnID != "" {
			t := rec.TurnID
			a.TurnID = &t
		}
		if n := len(rec.Events); n > 0 {
			e := rec.Events[n-1]
			a.Latest = &e
		}
		out = append(out, a)
	}
	return out
}

func settingsFiles(dirs posture.Dirs) []SettingsFile {
	var out []SettingsFile
	for _, f := range dirs.Locate() {
		sf := SettingsFile{Label: f.Label, Path: f.Path}
		data, err := os.ReadFile(f.Path)
		if errors.Is(err, fs.ErrNotExist) {
			out = append(out, sf)
			continue
		}
		sf.Present = true
		if err == nil {
			var parsed map[string]json.RawMessage
			if err = json.Unmarshal(data, &parsed); err == nil {
				sf.Keys = orderedKeys(data)
				sf.Permissions = summarizePermissions(parsed["permissions"])
				sf.Sandbox = summarizeSandbox(parsed["sandbox"])
				out = append(out, sf)
				continue
			}
		}
		sf.Error = err.Error()
		out = append(out, sf)
	}
	return out
}

func summarizePermissions(raw json.RawMessage) *PermissionsSummary {
	var p map[string]any
	if json.Unmarshal(raw, &p) != nil || p == nil {
		return nil
	}
	s := &PermissionsSummary{}
	if m, ok := p["defaultMode"].(string); ok {
		s.DefaultMode = &m
	}
	count := func(key string) *int {
		if list, ok := p[key].([]any); ok {
			n := len(list)
			return &n
		}
		return nil
	}
	s.Allow, s.Deny, s.Ask, s.AdditionalDirectories = count("allow"), count("deny"), count("ask"), count("additionalDirectories")
	return s
}

func summarizeSandbox(raw json.RawMessage) *SandboxSummary {
	var s map[string]json.RawMessage
	if json.Unmarshal(raw, &s) != nil || s == nil {
		return nil
	}
	out := &SandboxSummary{}
	var enabled bool
	if json.Unmarshal(s["enabled"], &enabled) == nil && s["enabled"] != nil {
		out.Enabled = &enabled
	}
	if isObject(s["filesystem"]) {
		out.Filesystem = orderedKeys(s["filesystem"])
	}
	if isObject(s["network"]) {
		out.Network = orderedKeys(s["network"])
	}
	return out
}

func isObject(raw json.RawMessage) bool {
	raw = bytes.TrimSpace(raw)
	return len(raw) > 0 && raw[0] == '{'
}

// orderedKeys is an object's top-level keys in the order written.
func orderedKeys(raw []byte) []string {
	dec := json.NewDecoder(bytes.NewReader(raw))
	keys := []string{}
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return keys
	}
	for dec.More() {
		t, err := dec.Token()
		if err != nil {
			return keys
		}
		if k, ok := t.(string); ok {
			keys = append(keys, k)
		}
		var skip json.RawMessage
		if dec.Decode(&skip) != nil {
			return keys
		}
	}
	return keys
}
