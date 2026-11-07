//go:build integration

package integration

// Settings with per-host domain rules, mirrored into a profile in an
// isolated CODEX_HOME, and a thread selecting it: the denylist bites. The
// real composition of mirror, codexhome and run, not codex directly.

import (
	"context"
	"regexp"
	"testing"

	"github.com/danielbodart/dragoman/internal/posture"
)

func TestADeniedDomainIsBlockedThroughTheRegistry(t *testing.T) {
	modelTurn(t)
	verifyOnce(t, func(t *testing.T) {
		runs := profiledRuns(t, posture.Effective{SandboxEnabled: ptr(true), AllowedDomains: []string{"example.com"}, DeniedDomains: []string{"example.org"}}, &scripted{decision: "decline"})
		h, err := runs.Start(context.Background(), `Run exactly this and report its outcome verbatim: curl -sS -m 12 -o /dev/null -w 'http=%{http_code}' https://example.org; echo " rc=$?"`, tempDir(t), "dontAsk")
		if err != nil {
			t.Fatal(err)
		}
		rec := settle(t, runs, h)
		// Codex's wording for a refusal varies by version: match the family.
		if rec.Status != "done" || !regexp.MustCompile(`(?i)blocked|denied|policy|rejected|environment|rc=[^0]`).MatchString(resultText(rec)) {
			t.Fatalf("status %s: %q", rec.Status, resultText(rec))
		}
	})
}
