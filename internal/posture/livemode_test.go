package posture

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/danielbodart/gokit/environ"
)

const call = "toolu_01ABCdef234"

func runtime(t *testing.T) environ.Env {
	return environ.Env{"XDG_RUNTIME_DIR": t.TempDir()}
}

func TestTakeLiveModeReadsTheModeForThisCallThenDeletesIt(t *testing.T) {
	env := runtime(t)
	if err := os.MkdirAll(LiveModeDir(env), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(LiveModeDir(env), call), []byte("plan\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	same(t, TakeLiveMode(call, env), "plan")
	same(t, TakeLiveMode(call, env), "") // consumed: it can never apply twice
}

func TestTakeLiveModeIgnoresAnotherCallsFile(t *testing.T) {
	env := runtime(t)
	_ = os.MkdirAll(LiveModeDir(env), 0o700)
	_ = os.WriteFile(filepath.Join(LiveModeDir(env), "toolu_earlier"), []byte("bypassPermissions\n"), 0o600)
	same(t, TakeLiveMode(call, env), "")
}

func TestTakeLiveModeWithoutAnIDOrWithAnUnsafeOneIsNothing(t *testing.T) {
	env := runtime(t)
	same(t, TakeLiveMode("", env), "")
	same(t, LiveModePath("../etc", env), "")
}

func TestLiveModeDirFallsBackToTMPDIR(t *testing.T) {
	same(t, LiveModeDir(environ.Env{"TMPDIR": "/rt"}), filepath.Join("/rt", "dragoman", "live-mode"))
}

func TestToolUseIDOfReadsClaudeCodesIDOffTheMeta(t *testing.T) {
	same(t, ToolUseIDOf(map[string]any{"claudecode/toolUseId": call}), call)
	same(t, ToolUseIDOf(nil), "")
	same(t, ToolUseIDOf(map[string]any{"claudecode/toolUseId": 7.0}), "")
}

func TestRecordLiveModeIsWhatTakeLiveModeTakes(t *testing.T) {
	env := runtime(t)
	if err := RecordLiveMode(call, "acceptEdits", env); err != nil {
		t.Fatal(err)
	}
	same(t, TakeLiveMode(call, env), "acceptEdits")
}

func TestRecordLiveModeLeavesNoTempFilesBehind(t *testing.T) {
	env := runtime(t)
	if err := RecordLiveMode(call, "auto", env); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(LiveModeDir(env))
	if len(entries) != 1 || entries[0].Name() != call {
		t.Fatalf("got %v", entries)
	}
}

func TestRecordLiveModeWritesNothingForAMissingModeOrIDOrAnUnsafeID(t *testing.T) {
	env := runtime(t)
	for _, c := range [][2]string{{call, ""}, {"", "plan"}, {"../../evil", "plan"}} {
		if err := RecordLiveMode(c[0], c[1], env); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(LiveModeDir(env)); !os.IsNotExist(err) {
		t.Fatalf("nothing should be written, got %v", err)
	}
}
