package codexhome

// Isolated config, shared state. The per-run home isolates only what must be
// per-run: config.toml (the managed profile and the global network_proxy
// flag) and rules/ (Claude's live allow/deny, auto-discovered per home).
// Everything else splits by what it is:
//
//   - Thread state (sessions/ and session_index.jsonl), the rollout
//     thread/resume needs: symlinked from a Dragoman-owned store
//     (~/.dragoman/shared), never the real codex home, so Dragoman never
//     writes history into ~/.codex.
//   - Caches (cache/ and models_cache.json): symlinked to the real codex
//     home, so a run reuses the user's warm model cache.
//
// auth.json is symlinked to the real home too. The sqlite state and lock
// dirs are not shared at all: concurrent runs writing one sqlite would risk
// corruption, and resume rebuilds from the rollout.

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/danielbodart/gokit/atomicfile"
	"github.com/danielbodart/gokit/environ"
)

var (
	stateDirs  = []string{"sessions"}
	stateFiles = []string{"session_index.jsonl"}
	cacheDirs  = []string{"cache"}
	cacheFiles = []string{"models_cache.json"}
)

// Layout is where a home inherits from and lives.
type Layout struct {
	// RealHome is the codex home to inherit auth and config from:
	// $CODEX_HOME, else ~/.codex.
	RealHome string
	// IsolatedHome is the home to build.
	IsolatedHome string
	// SharedStore holds the thread rollout, linked into every home so a
	// thread outlives its run's home. Empty skips state sharing.
	SharedStore string
}

// LayoutFrom resolves the real, isolated and shared paths: $CODEX_HOME or
// ~/.codex, and $DRAGOMAN_HOME or ~/.dragoman.
func LayoutFrom(env environ.Env, home string) Layout {
	real := env["CODEX_HOME"]
	if real == "" {
		real = filepath.Join(home, ".codex")
	}
	dragoman := env["DRAGOMAN_HOME"]
	if dragoman == "" {
		dragoman = filepath.Join(home, ".dragoman")
	}
	return Layout{RealHome: real, IsolatedHome: filepath.Join(dragoman, "codex-home"), SharedStore: filepath.Join(dragoman, "shared")}
}

// Ensure builds or refreshes the isolated home and returns its path, to set
// as CODEX_HOME. Idempotent.
//
// default_permissions is written only once a profile exists (Codex requires
// it then), as :workspace, and only when the user's own config sets none.
func Ensure(profiles []Profile, layout Layout, rules string) (string, error) {
	home := layout.IsolatedHome
	if err := os.MkdirAll(home, 0o755); err != nil {
		return "", err
	}
	if err := linkFile(filepath.Join(layout.RealHome, "auth.json"), filepath.Join(home, "auth.json")); err != nil {
		return "", err
	}
	if layout.SharedStore != "" {
		if err := linkGroup(home, layout.SharedStore, stateDirs, stateFiles); err != nil {
			return "", err
		}
		if exists(layout.RealHome) {
			if err := linkGroup(home, layout.RealHome, cacheDirs, cacheFiles); err != nil {
				return "", err
			}
		}
	}

	user, err := os.ReadFile(filepath.Join(layout.RealHome, "config.toml"))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	config := SpliceManagedBlock(string(user), RenderManagedBlock(profiles))
	if len(profiles) > 0 {
		config = WithDefaultPermissions(config, ":workspace")
	}
	if err := atomicfile.Write(filepath.Join(home, "config.toml"), []byte(config), 0o644); err != nil {
		return "", err
	}

	if rules != "" {
		dir := filepath.Join(home, "rules")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return "", err
		}
		if err := atomicfile.Write(filepath.Join(dir, "dragoman.rules"), []byte(rules), 0o644); err != nil {
			return "", err
		}
	}
	return home, nil
}

// linkFile points link at target, refreshed each call, and only when target
// exists.
func linkFile(target, link string) error {
	if err := os.Remove(link); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if !exists(target) {
		return nil
	}
	return os.Symlink(target, link)
}

// linkGroup links dirs and files from target into home. The dirs are created
// (codex writes into them through the link); the files may dangle until
// codex first writes them.
func linkGroup(home, target string, dirs, files []string) error {
	for _, d := range dirs {
		if err := os.MkdirAll(filepath.Join(target, d), 0o755); err != nil {
			return err
		}
	}
	for _, name := range append(append([]string{}, dirs...), files...) {
		link := filepath.Join(home, name)
		if err := os.RemoveAll(link); err != nil {
			return err
		}
		if err := os.Symlink(filepath.Join(target, name), link); err != nil {
			return err
		}
	}
	return nil
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
