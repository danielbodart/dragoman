package app

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/danielbodart/dragoman/internal/codex/codextest"
	"github.com/danielbodart/dragoman/internal/posture"
	"github.com/danielbodart/dragoman/internal/run"
	"github.com/danielbodart/gokit/environ"
	"github.com/danielbodart/gokit/logx"
)

// Wired with no Settings, the container reads Claude's settings from disk,
// at CLAUDE_CONFIG_DIR and CLAUDE_PROJECT_DIR, each time a run starts. (The
// TypeScript once had this default refer to itself and recurse forever.)
func TestTheDefaultSettingsReaderIsTheDiskOne(t *testing.T) {
	config, project := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(config, "settings.json"), []byte(`{"permissions":{"defaultMode":"acceptEdits"}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	fake := codextest.New()
	fake.Result("thread/start", map[string]any{"thread": map[string]any{"id": "t9"}})
	fake.Result("turn/start", map[string]any{"turn": map[string]any{"id": "turn9"}})
	var policy posture.Policy
	c := &Container{
		Env:  environ.Env{"CLAUDE_CONFIG_DIR": config, "CLAUDE_PROJECT_DIR": project},
		Home: t.TempDir(), Cwd: project, Log: logx.Discard,
		Provision: func(_ context.Context, p posture.Policy) (run.Provisioned, error) {
			policy = p
			return run.Provisioned{Conn: fake.Client}, nil
		},
	}
	if err := c.Wire(context.Background()); err != nil {
		t.Fatal(err)
	}
	h, err := c.Runs.Start(context.Background(), "do the thing", "/repo", "")
	if err != nil || h != "t9" {
		t.Fatalf("got %q, %v", h, err)
	}
	if policy.Profile == nil || policy.Profile.Base != ":workspace" {
		t.Fatalf("acceptEdits from disk should give :workspace, got %+v", policy.Profile)
	}
}
