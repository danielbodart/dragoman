//go:build integration

package integration

// The approval bridge on a real turn, the thing this project exists for.
// Under `default` (untrusted, reviewer user) the app-server round-trips
// item/commandExecution/requestApproval to the client. The evidence is
// whether the human was asked.

import (
	"context"
	"testing"

	"github.com/danielbodart/dragoman/internal/posture"
)

const runEcho = "Use your shell to run exactly this one command and then stop; do not run anything else: echo dragoman-probe hi"

func manualTurn(t *testing.T, s posture.Effective) int {
	t.Helper()
	el := &scripted{decision: "decline"}
	runs := profiledRuns(t, s, el)
	h, err := runs.Start(context.Background(), runEcho, tempDir(t), "default")
	if err != nil {
		t.Fatal(err)
	}
	settle(t, runs, h)
	return el.count()
}

func TestAnUnmatchedCommandPromptsTheHuman(t *testing.T) {
	modelTurn(t)
	verifyOnce(t, func(t *testing.T) {
		if asks := manualTurn(t, posture.Effective{}); asks == 0 {
			t.Fatal("want a prompt")
		}
	})
}

func TestACommandMatchingAnAllowRuleIsAutoAccepted(t *testing.T) {
	modelTurn(t)
	verifyOnce(t, func(t *testing.T) {
		if asks := manualTurn(t, posture.Effective{Allow: []string{"Bash(echo dragoman-probe:*)"}}); asks != 0 {
			t.Fatalf("asked %d times", asks)
		}
	})
}

func TestACommandMatchingADenyRuleIsPreDeclined(t *testing.T) {
	modelTurn(t)
	verifyOnce(t, func(t *testing.T) {
		if asks := manualTurn(t, posture.Effective{Deny: []string{"Bash(echo:*)"}}); asks != 0 {
			t.Fatalf("asked %d times", asks)
		}
	})
}
