//go:build integration

package integration

import (
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// verifyOnce runs a live test until it first passes, then skips it: a
// one-way ratchet. The marker is a hash of the test's name and its file's
// contents, so editing the file runs it again; a failing run writes none.
func verifyOnce(t *testing.T, fn func(t *testing.T)) {
	t.Helper()
	command := codexCommand()
	if _, err := exec.LookPath(command[0]); err != nil {
		t.Skipf("%s is not on PATH", command[0])
	}
	_, file, _, _ := runtime.Caller(1)
	source, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	dir, _ := os.Getwd()
	state := filepath.Join(dir, ".state")
	marker := filepath.Join(state, fmt.Sprintf("%x.passed", sha256.Sum256(append([]byte(t.Name()+"\n"), source...))))
	if _, err := os.Stat(marker); err == nil {
		t.Skip("passed before (delete internal/integration/.state to run it again)")
	}
	fn(t)
	if t.Failed() {
		return
	}
	_ = os.MkdirAll(state, 0o755)
	_ = os.WriteFile(marker, []byte(t.Name()+"\n"+time.Now().UTC().Format(time.RFC3339)+"\n"), 0o644)
}

// modelTurn skips a test that spends a model turn unless asked for.
func modelTurn(t *testing.T) {
	t.Helper()
	if os.Getenv("DRAGOMAN_MODEL_TESTS") != "1" {
		t.Skip("spends a model turn: set DRAGOMAN_MODEL_TESTS=1")
	}
}

func codexCommand() []string {
	if v := os.Getenv("DRAGOMAN_CODEX_COMMAND"); v != "" {
		return strings.Split(v, " ")
	}
	return []string{"codex", "app-server"}
}
