//go:build integration

package integration

// Does Codex honour the permission profile the mirror emits? Each test spawns
// codex against an isolated home carrying the mirrored profile and runs
// command/exec under it: model-free. Writable roots (additionalDirectories)
// ride thread/start's runtimeWorkspaceRoots, which command/exec has no
// equivalent for, so they are covered in the run tests and the profile test.

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/danielbodart/dragoman/internal/codex"
	"github.com/danielbodart/dragoman/internal/posture"
	"github.com/danielbodart/dragoman/internal/protocol"
)

// bypassPermissions has no profile (:danger-full-access is not an
// extendable base), so it runs under the sandbox enum.
func TestDangerCanWriteOutsideTheWorkspace(t *testing.T) {
	verifyOnce(t, func(t *testing.T) {
		withCodex(t, nil, func(conn codex.Conn) {
			cwd, outside := tempDir(t), tempDir(t)
			res := execPolicy(t, conn, []string{"touch", filepath.Join(outside, "probe.txt")}, cwd, protocol.SandboxPolicy{DangerFullAccess: &protocol.DangerFullAccessSandboxPolicy{}})
			if res.ExitCode != 0 {
				t.Fatalf("exit %d: %s", res.ExitCode, res.Stderr)
			}
		})
	})
}

func TestTheWorkspaceProfileAllowsCwdWritesButBlocksOutside(t *testing.T) {
	verifyOnce(t, func(t *testing.T) {
		withProfiledCodex(t, posture.Effective{}, posture.AcceptEdits, func(conn codex.Conn, profile string) {
			cwd, outside := tempDir(t), tempDir(t)
			if r := execProfiled(t, conn, []string{"touch", filepath.Join(cwd, "in.txt")}, cwd, profile); r.ExitCode != 0 {
				t.Fatalf("in cwd: exit %d: %s", r.ExitCode, r.Stderr)
			}
			if r := execProfiled(t, conn, []string{"touch", filepath.Join(outside, "out.txt")}, cwd, profile); r.ExitCode == 0 {
				t.Fatal("outside the workspace should be blocked")
			}
		})
	})
}

func TestTheReadOnlyProfileAllowsReadsButBlocksWrites(t *testing.T) {
	verifyOnce(t, func(t *testing.T) {
		withProfiledCodex(t, posture.Effective{}, posture.Default, func(conn codex.Conn, profile string) {
			cwd := tempDir(t)
			seed := filepath.Join(cwd, "seed.txt")
			if err := os.WriteFile(seed, []byte("hi"), 0o644); err != nil {
				t.Fatal(err)
			}
			if r := execProfiled(t, conn, []string{"cat", seed}, cwd, profile); r.ExitCode != 0 {
				t.Fatalf("read: exit %d: %s", r.ExitCode, r.Stderr)
			}
			if r := execProfiled(t, conn, []string{"touch", filepath.Join(cwd, "w.txt")}, cwd, profile); r.ExitCode == 0 {
				t.Fatal("a write should be blocked")
			}
		})
	})
}

var curl = []string{"curl", "-sS", "-m", "10", "-o", "/dev/null", "https://example.com"}

func TestNoClaudeSandboxMeansNetworkOn(t *testing.T) {
	verifyOnce(t, func(t *testing.T) {
		withProfiledCodex(t, posture.Effective{}, posture.AcceptEdits, func(conn codex.Conn, profile string) {
			if r := execProfiled(t, conn, curl, tempDir(t), profile); r.ExitCode != 0 {
				t.Fatalf("exit %d: %s", r.ExitCode, r.Stderr)
			}
		})
	})
}

func TestSandboxOnWithNoAllowlistBlocksNetwork(t *testing.T) {
	verifyOnce(t, func(t *testing.T) {
		withProfiledCodex(t, posture.Effective{SandboxEnabled: ptr(true)}, posture.AcceptEdits, func(conn codex.Conn, profile string) {
			if r := execProfiled(t, conn, curl, tempDir(t), profile); r.ExitCode == 0 {
				t.Fatal("network should be blocked")
			}
		})
	})
}

func TestSandboxOnWithAnAllowlistedDomainReachesIt(t *testing.T) {
	verifyOnce(t, func(t *testing.T) {
		withProfiledCodex(t, posture.Effective{SandboxEnabled: ptr(true), AllowedDomains: []string{"example.com"}}, posture.AcceptEdits, func(conn codex.Conn, profile string) {
			if r := execProfiled(t, conn, curl, tempDir(t), profile); r.ExitCode != 0 {
				t.Fatalf("exit %d: %s", r.ExitCode, r.Stderr)
			}
		})
	})
}
