package posture

import (
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/danielbodart/gokit/environ"
	"github.com/danielbodart/gokit/logx"
)

func ptr[T any](v T) *T { return &v }

func same[T any](t *testing.T, got, want T) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}

func TestMergeUnionsPermissionArraysDeduplicated(t *testing.T) {
	user := Settings{Allow: []string{"Bash(ls)", "Read(/a)"}}
	project := Settings{Allow: []string{"Bash(ls)", "Bash(git status)"}}
	same(t, Merge([]Settings{user, project}).Allow, []string{"Bash(ls)", "Read(/a)", "Bash(git status)"})
}

func TestMergeScalarsTakeTheHighestLayerThatSetsThem(t *testing.T) {
	same(t, *Merge([]Settings{{DefaultMode: ptr("default")}, {DefaultMode: ptr("plan")}}).DefaultMode, "plan")
}

func TestMergeALayerWithoutAScalarDoesNotClobberALowerOne(t *testing.T) {
	same(t, *Merge([]Settings{{DefaultMode: ptr("acceptEdits")}, {Allow: []string{"Bash(ls)"}}}).DefaultMode, "acceptEdits")
}

func TestMergeUnionsSandboxFilesystemAndNetworkArrays(t *testing.T) {
	a := Settings{DenyRead: []string{"/etc"}, AllowedDomains: []string{"a.com"}}
	b := Settings{DenyRead: []string{"/root"}, AllowedDomains: []string{"b.com"}}
	m := Merge([]Settings{a, b})
	same(t, m.DenyRead, []string{"/etc", "/root"})
	same(t, m.AllowedDomains, []string{"a.com", "b.com"})
}

func TestMergeOfNothingIsEmptyArraysAndUnsetScalars(t *testing.T) {
	m := Merge(nil)
	same(t, m.Allow, []string{})
	if m.DefaultMode != nil || m.SandboxEnabled != nil {
		t.Fatal("scalars should be unset")
	}
}

func TestLocateAnchorsOnClaudeProjectDirAndClaudeConfigDir(t *testing.T) {
	dirs := DirsFrom(environ.Env{"CLAUDE_PROJECT_DIR": "/proj", "CLAUDE_CONFIG_DIR": "/cfg"}, "/cwd", "/home")
	var paths []string
	for _, f := range dirs.Locate() {
		paths = append(paths, f.Path)
	}
	same(t, paths, []string{"/cfg/settings.json", "/cfg/settings.local.json", "/proj/.claude/settings.json", "/proj/.claude/settings.local.json"})
}

func TestLocateFallsBackToTheWorkingDirectoryAndHome(t *testing.T) {
	dirs := DirsFrom(environ.Env{}, "/cwd", "/home")
	same(t, dirs, Dirs{Project: "/cwd", Config: "/home/.claude"})
}

func TestParseSettingsReadsThePermissionAndSandboxKeys(t *testing.T) {
	s, err := ParseSettings([]byte(`{
		"permissions": {"defaultMode": "plan", "allow": ["Bash(ls)"], "deny": ["Bash(rm:*)"], "ask": ["x"], "additionalDirectories": ["/data"]},
		"sandbox": {"enabled": true,
			"filesystem": {"denyRead": ["/a"], "denyWrite": ["/b"], "allowRead": ["/c"], "allowWrite": ["/d"]},
			"network": {"allowedDomains": ["a.com"], "deniedDomains": ["b.com"], "strictAllowlist": false}}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	same(t, s, Settings{
		DefaultMode: ptr("plan"), Allow: []string{"Bash(ls)"}, Deny: []string{"Bash(rm:*)"}, Ask: []string{"x"}, AdditionalDirectories: []string{"/data"},
		SandboxEnabled: ptr(true), DenyRead: []string{"/a"}, DenyWrite: []string{"/b"}, AllowRead: []string{"/c"}, AllowWrite: []string{"/d"},
		AllowedDomains: []string{"a.com"}, DeniedDomains: []string{"b.com"}, StrictAllowlist: ptr(false),
	})
}

// Claude Code owns settings.json. Keys Dragoman has never heard of, a value
// of the wrong type, a mode Claude added after this build: each is left
// alone, and the rest still mirrors.
func TestSettingsAreReadLeniently(t *testing.T) {
	s, err := ParseSettings([]byte(`{
		"theme": "dark", "someFutureKey": {"deep": [1, 2]},
		"permissions": {"defaultMode": "someFutureMode", "allow": ["Bash(ls)", 42, null], "deny": "Bash(rm:*)", "newList": ["x"]},
		"sandbox": {"enabled": "yes", "network": {"allowedDomains": ["a.com"], "newRule": true}}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	same(t, s.Allow, []string{"Bash(ls)"})
	if s.Deny != nil || s.SandboxEnabled != nil {
		t.Fatalf("wrong-typed values should be left unset: %#v", s)
	}
	same(t, s.AllowedDomains, []string{"a.com"})
	mode, unknown := ResolveMode(Merge([]Settings{s}), "")
	same(t, mode, Default)
	same(t, unknown, "someFutureMode")
}

// A missing file is a normal absence; one that will not parse is skipped
// with a warning, and the rest still merge.
func TestReadSkipsMissingAndUnreadableFiles(t *testing.T) {
	config, project := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(config, "settings.json"), []byte(`{"permissions":{"allow":["Bash(ls)"]}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(project, ".claude"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, ".claude", "settings.json"), []byte(`{not json`), 0o644); err != nil {
		t.Fatal(err)
	}
	var said strings.Builder
	got := Dirs{Project: project, Config: config}.Read(logx.Writers(&said, &said))
	same(t, got.Allow, []string{"Bash(ls)"})
	if !strings.Contains(said.String(), "ignoring unreadable settings") {
		t.Fatalf("want a warning, got %q", said.String())
	}
	if slices.Contains(got.Allow, "") {
		t.Fatal("nothing from the broken file")
	}
}
