package hook

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/danielbodart/dragoman/internal/posture"
	"github.com/danielbodart/gokit/environ"
)

const call = "toolu_01ABCdef234"

func runtimeEnv(t *testing.T) environ.Env { return environ.Env{"XDG_RUNTIME_DIR": t.TempDir()} }

func TestPostureRecordsTheLiveModeForTheServerToTake(t *testing.T) {
	env := runtimeEnv(t)
	Posture(strings.NewReader(`{"session_id":"5d288149-f8b3-4cca-87ac-df1e7ecb5a50","tool_use_id":"`+call+`","permission_mode":"acceptEdits","tool_name":"mcp__plugin_dragoman_bridge__codex_run","tool_input":{"prompt":"p","cwd":"/x"}}`), env)
	if got := posture.TakeLiveMode(call, env); got != "acceptEdits" {
		t.Fatalf("got %q", got)
	}
}

func TestPostureLeavesNoTempFilesBehind(t *testing.T) {
	env := runtimeEnv(t)
	Posture(strings.NewReader(`{"tool_use_id":"`+call+`","permission_mode":"auto"}`), env)
	entries, _ := os.ReadDir(posture.LiveModeDir(env))
	if len(entries) != 1 || entries[0].Name() != call {
		t.Fatalf("got %v", entries)
	}
}

func TestPostureWritesNothingForAMissingModeOrIDOrAnUnsafeID(t *testing.T) {
	env := runtimeEnv(t)
	for _, in := range []string{`{"tool_use_id":"` + call + `"}`, `{"permission_mode":"plan"}`, `{"tool_use_id":"../../evil","permission_mode":"plan"}`} {
		Posture(strings.NewReader(in), env)
	}
	if _, err := os.Stat(posture.LiveModeDir(env)); !os.IsNotExist(err) {
		t.Fatalf("got %v", err)
	}
}

// Claude Code owns the hook input: fields it adds are ignored; a field of
// the wrong type, or input that isn't JSON, records nothing and fails
// nothing.
func TestPostureReadsTheHookInputLeniently(t *testing.T) {
	env := runtimeEnv(t)
	Posture(strings.NewReader(`{"tool_use_id":"`+call+`","permission_mode":"plan","someFutureField":{"x":[1]},"cwd":7}`), env)
	if got := posture.TakeLiveMode(call, env); got != "plan" {
		t.Fatalf("got %q", got)
	}
	Posture(strings.NewReader(`{"tool_use_id":"`+call+`","permission_mode":42}`), env)
	Posture(strings.NewReader(`not json`), env)
	if got := posture.TakeLiveMode(call, env); got != "" {
		t.Fatalf("got %q", got)
	}
}

func TestCheckSaysNothingWhenCodexIsOnPath(t *testing.T) {
	var out strings.Builder
	Check(strings.NewReader("{}"), &out, func(string) (string, error) { return "/bin/codex", nil })
	if out.String() != "" {
		t.Fatalf("got %q", out.String())
	}
}

func TestCheckTellsClaudeWhenCodexIsMissing(t *testing.T) {
	var out strings.Builder
	Check(strings.NewReader("{}"), &out, func(string) (string, error) { return "", errors.New("not found") })
	if !strings.Contains(out.String(), `"hookEventName":"SessionStart"`) || !strings.Contains(out.String(), "`codex` is not on PATH") {
		t.Fatalf("got %q", out.String())
	}
}

// hooks.json routes the three provisioning tools, and only those, through
// the posture hook.
func TestHooksJSONRoutesTheProvisioningToolsThroughThePostureHook(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "packaging", "hooks.json"))
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`"matcher":\s*"([^"]+)"`).FindStringSubmatch(string(raw))
	matcher := regexp.MustCompile("^(?:" + m[1] + ")$")
	for _, tool := range []string{"codex_run", "codex_continue", "codex_review"} {
		if !matcher.MatchString("mcp__plugin_dragoman_bridge__" + tool) {
			t.Fatalf("%s not matched", tool)
		}
	}
	if matcher.MatchString("mcp__plugin_dragoman_bridge__codex_status") {
		t.Fatal("codex_status matched")
	}
	if !strings.Contains(string(raw), "bin/dragoman hook posture") || !strings.Contains(string(raw), "bin/dragoman hook check") {
		t.Fatalf("hooks.json: %s", raw)
	}
}
