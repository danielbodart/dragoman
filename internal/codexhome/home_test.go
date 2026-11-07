package codexhome

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var profiles = []Profile{{ID: "dragoman-workspace", Base: ":workspace", Network: &Network{Enabled: true, Domains: []Entry{{"example.com", "allow"}, {"example.org", "deny"}}}}}

func homes(t *testing.T) (root, real, isolated string) {
	t.Helper()
	root = t.TempDir()
	real, isolated = filepath.Join(root, "real"), filepath.Join(root, "isolated")
	must(t, os.MkdirAll(real, 0o755))
	must(t, os.WriteFile(filepath.Join(real, "auth.json"), []byte(`{"token":"real"}`), 0o600))
	must(t, os.WriteFile(filepath.Join(real, "config.toml"), []byte("approval_policy = \"on-request\"\n"), 0o644))
	return
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func ensure(t *testing.T, p []Profile, l Layout) string {
	t.Helper()
	home, err := Ensure(p, l, "")
	must(t, err)
	return home
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	must(t, err)
	return string(b)
}

func link(t *testing.T, path string) string {
	t.Helper()
	info, err := os.Lstat(path)
	must(t, err)
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("%s is not a symlink", path)
	}
	target, err := os.Readlink(path)
	must(t, err)
	return target
}

func TestEnsureReturnsTheIsolatedHomeAndCreatesIt(t *testing.T) {
	_, real, isolated := homes(t)
	equal(t, ensure(t, profiles, Layout{RealHome: real, IsolatedHome: isolated}), isolated)
	if _, err := os.Stat(isolated); err != nil {
		t.Fatal(err)
	}
}

// The rollout written through the link lands in the store, so deleting this
// home keeps it: codex_continue resumes from the store.
func TestASharedStoreLinksDurableStateSoItOutlivesTheHome(t *testing.T) {
	root, real, isolated := homes(t)
	store := filepath.Join(root, "shared")
	ensure(t, nil, Layout{RealHome: real, IsolatedHome: isolated, SharedStore: store})
	sessions := filepath.Join(isolated, "sessions")
	equal(t, link(t, sessions), filepath.Join(store, "sessions"))
	equal(t, link(t, filepath.Join(isolated, "session_index.jsonl")), filepath.Join(store, "session_index.jsonl"))
	// Caches point at the real home, for a warm start.
	equal(t, link(t, filepath.Join(isolated, "cache")), filepath.Join(real, "cache"))
	equal(t, link(t, filepath.Join(isolated, "models_cache.json")), filepath.Join(real, "models_cache.json"))

	must(t, os.WriteFile(filepath.Join(sessions, "rollout.jsonl"), []byte("x"), 0o644))
	must(t, os.RemoveAll(isolated))
	if _, err := os.Stat(filepath.Join(store, "sessions", "rollout.jsonl")); err != nil {
		t.Fatal(err)
	}
}

func TestWithoutASharedStoreNoStateIsShared(t *testing.T) {
	_, real, isolated := homes(t)
	ensure(t, nil, Layout{RealHome: real, IsolatedHome: isolated})
	if _, err := os.Lstat(filepath.Join(isolated, "sessions")); !os.IsNotExist(err) {
		t.Fatalf("got %v", err)
	}
}

func TestAuthIsASymlinkToTheRealHome(t *testing.T) {
	_, real, isolated := homes(t)
	ensure(t, profiles, Layout{RealHome: real, IsolatedHome: isolated})
	equal(t, link(t, filepath.Join(isolated, "auth.json")), filepath.Join(real, "auth.json"))
	equal(t, read(t, filepath.Join(isolated, "auth.json")), `{"token":"real"}`)
}

func TestConfigIsTheUsersVerbatimPlusTheManagedBlock(t *testing.T) {
	_, real, isolated := homes(t)
	ensure(t, profiles, Layout{RealHome: real, IsolatedHome: isolated})
	config := read(t, filepath.Join(isolated, "config.toml"))
	contains(t, config, `approval_policy = "on-request"`)
	contains(t, config, "[features.network_proxy]\nenabled = true")
	contains(t, config, "[permissions.dragoman-workspace.network.domains]\n\"example.com\" = \"allow\"\n\"example.org\" = \"deny\"")
	contains(t, config, `default_permissions = ":workspace"`)
}

func TestTheUsersRealConfigIsNotTouched(t *testing.T) {
	_, real, isolated := homes(t)
	before := read(t, filepath.Join(real, "config.toml"))
	ensure(t, profiles, Layout{RealHome: real, IsolatedHome: isolated})
	equal(t, read(t, filepath.Join(real, "config.toml")), before)
}

func TestAUsersDefaultPermissionsIsKept(t *testing.T) {
	_, real, isolated := homes(t)
	must(t, os.WriteFile(filepath.Join(real, "config.toml"), []byte("default_permissions = \":danger-full-access\"\n"), 0o644))
	ensure(t, profiles, Layout{RealHome: real, IsolatedHome: isolated})
	config := read(t, filepath.Join(isolated, "config.toml"))
	contains(t, config, `default_permissions = ":danger-full-access"`)
	equal(t, strings.Count(config, "default_permissions"), 1)
}

func TestEnsureIsIdempotent(t *testing.T) {
	_, real, isolated := homes(t)
	l := Layout{RealHome: real, IsolatedHome: isolated}
	ensure(t, profiles, l)
	ensure(t, []Profile{{ID: "dragoman-workspace", Base: ":workspace", Network: &Network{Enabled: true, Domains: []Entry{{"only.com", "allow"}}}}}, l)
	config := read(t, filepath.Join(isolated, "config.toml"))
	equal(t, strings.Count(config, "DRAGOMAN MANAGED (do not edit"), 1)
	contains(t, config, `"only.com" = "allow"`)
	lacks(t, config, `"example.org" = "deny"`)
}

func TestNoProfilesIsTheUsersConfigVerbatim(t *testing.T) {
	_, real, isolated := homes(t)
	ensure(t, nil, Layout{RealHome: real, IsolatedHome: isolated})
	config := read(t, filepath.Join(isolated, "config.toml"))
	contains(t, config, `approval_policy = "on-request"`)
	lacks(t, config, "network_proxy")
	lacks(t, config, "DRAGOMAN MANAGED")
	lacks(t, config, "default_permissions")
	link(t, filepath.Join(isolated, "auth.json"))
}

func TestWorksWithoutARealConfig(t *testing.T) {
	_, real, isolated := homes(t)
	must(t, os.Remove(filepath.Join(real, "config.toml")))
	ensure(t, profiles, Layout{RealHome: real, IsolatedHome: isolated})
	contains(t, read(t, filepath.Join(isolated, "config.toml")), "DRAGOMAN MANAGED")
}

func TestRulesAreWrittenWhereCodexDiscoversThem(t *testing.T) {
	_, real, isolated := homes(t)
	rules := RenderRules([][]string{{"ls"}}, nil)
	_, err := Ensure(nil, Layout{RealHome: real, IsolatedHome: isolated}, rules)
	must(t, err)
	equal(t, read(t, filepath.Join(isolated, "rules", "dragoman.rules")), rules)
}

// Codex's config.toml is the user's and Codex's: whatever it holds, even
// tables and keys Dragoman has never heard of, passes through untouched.
func TestAnUnfamiliarUserConfigPassesThroughVerbatim(t *testing.T) {
	_, real, isolated := homes(t)
	odd := "model = \"gpt-9\"\n[some_future_table]\nnested = { a = 1, b = [\"x\"] }\n# a comment\n"
	must(t, os.WriteFile(filepath.Join(real, "config.toml"), []byte(odd), 0o644))
	ensure(t, profiles, Layout{RealHome: real, IsolatedHome: isolated})
	contains(t, read(t, filepath.Join(isolated, "config.toml")), odd)
}
