// Package posture mirrors Claude Code's posture onto Codex: it reads and
// merges Claude's settings, resolves the permission mode (the live one the
// PreToolUse hook records, else the static defaultMode, else a safe
// default), and compiles them into the Codex policy a run gets.
package posture

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/danielbodart/gokit/environ"
	"github.com/danielbodart/gokit/logx"
)

// Settings is the slice of one Claude Code settings layer Dragoman mirrors:
// only the permission and sandbox keys. The format is Claude Code's, so it
// is read leniently: a key it does not know, or one whose value is the wrong
// type, is left alone.
type Settings struct {
	DefaultMode           *string
	Allow                 []string
	Deny                  []string
	Ask                   []string
	AdditionalDirectories []string
	SandboxEnabled        *bool
	DenyRead              []string
	DenyWrite             []string
	AllowRead             []string
	AllowWrite            []string
	AllowedDomains        []string
	DeniedDomains         []string
	StrictAllowlist       *bool
}

// Effective is the merged posture: arrays unioned, scalars resolved.
type Effective = Settings

// ParseSettings reads one settings.json leniently. Only text that is not
// JSON, or not an object, is an error.
func ParseSettings(data []byte) (Settings, error) {
	var root map[string]any
	if err := json.Unmarshal(data, &root); err != nil {
		return Settings{}, err
	}
	if root == nil {
		return Settings{}, errors.New("not a JSON object")
	}
	perms := object(root["permissions"])
	sandbox := object(root["sandbox"])
	files := object(sandbox["filesystem"])
	network := object(sandbox["network"])
	return Settings{
		DefaultMode:           stringPtr(perms["defaultMode"]),
		Allow:                 stringList(perms["allow"]),
		Deny:                  stringList(perms["deny"]),
		Ask:                   stringList(perms["ask"]),
		AdditionalDirectories: stringList(perms["additionalDirectories"]),
		SandboxEnabled:        boolPtr(sandbox["enabled"]),
		DenyRead:              stringList(files["denyRead"]),
		DenyWrite:             stringList(files["denyWrite"]),
		AllowRead:             stringList(files["allowRead"]),
		AllowWrite:            stringList(files["allowWrite"]),
		AllowedDomains:        stringList(network["allowedDomains"]),
		DeniedDomains:         stringList(network["deniedDomains"]),
		StrictAllowlist:       boolPtr(network["strictAllowlist"]),
	}, nil
}

// Merge merges layers given low to high precedence (user, user-local,
// project, project-local): arrays union across all layers, de-duplicated in
// order; a scalar takes the highest layer that sets it. That is Claude's own
// rule, a union not an intersection.
func Merge(layers []Settings) Effective {
	union := func(pick func(Settings) []string) []string {
		out := []string{}
		seen := map[string]bool{}
		for _, l := range layers {
			for _, v := range pick(l) {
				if !seen[v] {
					seen[v] = true
					out = append(out, v)
				}
			}
		}
		return out
	}
	var e Effective
	for _, l := range layers {
		if l.DefaultMode != nil {
			e.DefaultMode = l.DefaultMode
		}
		if l.SandboxEnabled != nil {
			e.SandboxEnabled = l.SandboxEnabled
		}
		if l.StrictAllowlist != nil {
			e.StrictAllowlist = l.StrictAllowlist
		}
	}
	e.Allow = union(func(s Settings) []string { return s.Allow })
	e.Deny = union(func(s Settings) []string { return s.Deny })
	e.Ask = union(func(s Settings) []string { return s.Ask })
	e.AdditionalDirectories = union(func(s Settings) []string { return s.AdditionalDirectories })
	e.DenyRead = union(func(s Settings) []string { return s.DenyRead })
	e.DenyWrite = union(func(s Settings) []string { return s.DenyWrite })
	e.AllowRead = union(func(s Settings) []string { return s.AllowRead })
	e.AllowWrite = union(func(s Settings) []string { return s.AllowWrite })
	e.AllowedDomains = union(func(s Settings) []string { return s.AllowedDomains })
	e.DeniedDomains = union(func(s Settings) []string { return s.DeniedDomains })
	return e
}

// Dirs are the two roots Claude's settings live under.
type Dirs struct {
	// Project is $CLAUDE_PROJECT_DIR, the verified-reliable project anchor,
	// else the working directory.
	Project string
	// Config is $CLAUDE_CONFIG_DIR, else ~/.claude.
	Config string
}

// DirsFrom resolves the settings roots from the environment.
func DirsFrom(env environ.Env, cwd, home string) Dirs {
	d := Dirs{Project: env["CLAUDE_PROJECT_DIR"], Config: env["CLAUDE_CONFIG_DIR"]}
	if d.Project == "" {
		d.Project = cwd
	}
	if d.Config == "" {
		d.Config = filepath.Join(home, ".claude")
	}
	return d
}

// Locate is the four settings files, low to high precedence, each with the
// label diagnostics gives it.
func (d Dirs) Locate() []Located {
	return []Located{
		{"user", filepath.Join(d.Config, "settings.json")},
		{"user-local", filepath.Join(d.Config, "settings.local.json")},
		{"project", filepath.Join(d.Project, ".claude", "settings.json")},
		{"project-local", filepath.Join(d.Project, ".claude", "settings.local.json")},
	}
}

// Located is one settings file.
type Located struct {
	Label string
	Path  string
}

// Read reads and merges the settings files. A missing file is a normal
// absence. One that will not parse is skipped with a warning rather than
// taking the bridge down: a broken settings file should degrade mirroring,
// not break Codex.
func (d Dirs) Read(log logx.Logger) Effective {
	var layers []Settings
	for _, f := range d.Locate() {
		data, err := os.ReadFile(f.Path)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err == nil {
			var s Settings
			if s, err = ParseSettings(data); err == nil {
				layers = append(layers, s)
				continue
			}
		}
		log.Error("Dragoman: ignoring unreadable settings", f.Path+":", err)
	}
	return Merge(layers)
}

func object(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func stringList(v any) []string {
	list, _ := v.([]any)
	var out []string
	for _, x := range list {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func stringPtr(v any) *string {
	if s, ok := v.(string); ok {
		return &s
	}
	return nil
}

func boolPtr(v any) *bool {
	if b, ok := v.(bool); ok {
		return &b
	}
	return nil
}
