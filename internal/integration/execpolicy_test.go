//go:build integration

package integration

// Does the execpolicy .rules file the mirror emits bind on the production
// path, for every command, independent of the approval round-trip?

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/danielbodart/dragoman/internal/posture"
)

// bypassPermissions round-trips no approval at all: the gap the
// per-approval gate can't reach.
func TestADenyRuleForbidsTheCommandEvenInBypassPermissions(t *testing.T) {
	modelTurn(t)
	verifyOnce(t, func(t *testing.T) {
		cwd := tempDir(t)
		target := filepath.Join(cwd, "made.txt")
		runs := profiledRuns(t, posture.Effective{Deny: []string{"Bash(touch:*)"}}, &scripted{decision: "accept"})
		h, err := runs.Start(context.Background(), "Run exactly this one shell command, then stop: touch "+target, cwd, "bypassPermissions")
		if err != nil {
			t.Fatal(err)
		}
		if rec := settle(t, runs, h); rec.Status != "done" {
			t.Fatalf("status %s: %s", rec.Status, resultText(rec))
		}
		if _, err := os.Stat(target); err == nil {
			t.Fatal("the forbidden rule should have blocked it")
		}
	})
}

func TestAnAllowRuleRunsTheCommandWithNoPromptUnderManual(t *testing.T) {
	modelTurn(t)
	verifyOnce(t, func(t *testing.T) {
		el := &scripted{decision: "decline"}
		runs := profiledRuns(t, posture.Effective{Allow: []string{"Bash(python3:*)"}}, el)
		h, err := runs.Start(context.Background(), `Run exactly this one shell command and report only its output: python3 -c "print('PLUM-8842')" — then stop.`, tempDir(t), "default")
		if err != nil {
			t.Fatal(err)
		}
		rec := settle(t, runs, h)
		if rec.Status != "done" || el.count() != 0 || !strings.Contains(resultText(rec), "PLUM-8842") {
			t.Fatalf("status %s, asks %d, result %q", rec.Status, el.count(), resultText(rec))
		}
	})
}
