//go:build integration

package integration

// Does Codex honour the filesystem rules the mirror emits? Read-deny is
// model-free, and proves the table augments the base: a sibling read and a
// cwd write still work. The write-carve needs runtimeWorkspaceRoots, so it
// rides one real turn.

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/danielbodart/dragoman/internal/codex"
	"github.com/danielbodart/dragoman/internal/posture"
)

func TestDenyReadMakesAFileUnreadableWhileASiblingReadAndACwdWriteStillWork(t *testing.T) {
	verifyOnce(t, func(t *testing.T) {
		cwd := tempDir(t)
		secret, public := filepath.Join(cwd, "secret.txt"), filepath.Join(cwd, "public.txt")
		_ = os.WriteFile(secret, []byte("TOPSECRET\n"), 0o644)
		_ = os.WriteFile(public, []byte("hello\n"), 0o644)
		withProfiledCodex(t, posture.Effective{DenyRead: []string{secret}}, posture.AcceptEdits, func(conn codex.Conn, profile string) {
			if r := execProfiled(t, conn, []string{"cat", secret}, cwd, profile); r.ExitCode == 0 {
				t.Fatal("the denied read should be refused")
			}
			if r := execProfiled(t, conn, []string{"cat", public}, cwd, profile); r.ExitCode != 0 {
				t.Fatalf("sibling read: exit %d: %s", r.ExitCode, r.Stderr)
			}
			if r := execProfiled(t, conn, []string{"touch", filepath.Join(cwd, "in.txt")}, cwd, profile); r.ExitCode != 0 {
				t.Fatalf("cwd write: exit %d: %s", r.ExitCode, r.Stderr)
			}
		})
	})
}

// acceptEdits gives a writable workspace, the premise of a write-carve; the
// carved subpath is read-only by the profile's filesystem table.
func TestDenyWriteCarvesAReadOnlySubpathOutOfAWritableRoot(t *testing.T) {
	modelTurn(t)
	verifyOnce(t, func(t *testing.T) {
		cwd := tempDir(t)
		_ = os.MkdirAll(filepath.Join(cwd, "sub"), 0o755)
		_ = os.WriteFile(filepath.Join(cwd, "sub", "keep.txt"), []byte("K0"), 0o644)
		_ = os.WriteFile(filepath.Join(cwd, "top.txt"), []byte("T0"), 0o644)
		runs := profiledRuns(t, posture.Effective{DenyWrite: []string{filepath.Join(cwd, "sub")}}, &scripted{decision: "decline"})
		h, err := runs.Start(context.Background(), "Run exactly this shell command and report nothing else: printf X >> top.txt; printf X >> sub/keep.txt; echo DONE", cwd, "acceptEdits")
		if err != nil {
			t.Fatal(err)
		}
		if rec := settle(t, runs, h); rec.Status != "done" {
			t.Fatalf("status %s: %s", rec.Status, resultText(rec))
		}
		top, _ := os.ReadFile(filepath.Join(cwd, "top.txt"))
		keep, _ := os.ReadFile(filepath.Join(cwd, "sub", "keep.txt"))
		if string(top) != "T0X" || string(keep) != "K0" {
			t.Fatalf("top %q keep %q", top, keep)
		}
	})
}
