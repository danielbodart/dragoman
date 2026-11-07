//go:build integration

package integration

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/danielbodart/dragoman/internal/posture"
	"github.com/danielbodart/dragoman/internal/protocol"
)

// A thread resumes with its context after its run's home is torn down,
// which works only because the rollout lives in the shared store.
func TestAContinuationRecallsContextFromTheFirstTurn(t *testing.T) {
	modelTurn(t)
	verifyOnce(t, func(t *testing.T) {
		runs := profiledRuns(t, posture.Effective{}, &scripted{decision: "accept"})
		cwd := tempDir(t)
		h, err := runs.Start(context.Background(), "Remember this exact token: BANANA-42. Reply with only the word ok.", cwd, "default")
		if err != nil {
			t.Fatal(err)
		}
		if rec := settle(t, runs, h); rec.Status != "done" {
			t.Fatalf("first: %s %q", rec.Status, resultText(rec))
		}
		msg, err := runs.ContinueRun(context.Background(), h, "What exact token did I ask you to remember earlier? Reply with only that token.", "default")
		if err != nil || !strings.Contains(msg, "Continuing") {
			t.Fatalf("got %q, %v", msg, err)
		}
		rec := settle(t, runs, h)
		if rec.Status != "done" || !strings.Contains(resultText(rec), "BANANA-42") {
			t.Fatalf("second: %s %q", rec.Status, resultText(rec))
		}
	})
}

func TestReviewReturnsAFileAnchoredFindingOnTheUncommittedChanges(t *testing.T) {
	modelTurn(t)
	verifyOnce(t, func(t *testing.T) {
		cwd := tempDir(t)
		git := func(args ...string) {
			cmd := exec.Command("git", args...)
			cmd.Dir = cwd
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("git %v: %v %s", args, err, out)
			}
		}
		git("init", "-q")
		git("config", "user.email", "t@t.com")
		git("config", "user.name", "t")
		_ = os.WriteFile(filepath.Join(cwd, "sum.js"), []byte("export function sum(xs){let t=0;for(let i=0;i<xs.length;i++)t+=xs[i];return t;}\n"), 0o644)
		git("add", "-A")
		git("commit", "-qm", "init")
		// An off-by-one (`<=`): an obvious defect to flag.
		_ = os.WriteFile(filepath.Join(cwd, "sum.js"), []byte("export function sum(xs){let t=0;for(let i=0;i<=xs.length;i++)t+=xs[i];return t;}\n"), 0o644)
		runs := profiledRuns(t, posture.Effective{}, &scripted{decision: "accept"})
		h, err := runs.Review(context.Background(), cwd, protocol.ReviewTarget{UncommittedChanges: &protocol.UncommittedChangesReviewTarget{}}, "default")
		if err != nil {
			t.Fatal(err)
		}
		rec := settle(t, runs, h)
		review := resultText(rec)
		if rec.Status != "done" || !strings.Contains(review, "sum.js") || !regexp.MustCompile(`(?i)loop|boundary|off-by-one|length|<=|past the end`).MatchString(review) {
			t.Fatalf("%s: %q", rec.Status, review)
		}
	})
}
