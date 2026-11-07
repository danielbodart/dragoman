//go:build integration

package integration

// A WebFetch(domain:x) rule: Codex reaches x through the shell without a
// prompt (an implicit curl/wget allow), and the network allowlist fences
// which hosts.

import (
	"context"
	"strings"
	"testing"

	"github.com/danielbodart/dragoman/internal/posture"
)

func curlPrompt(host string) string {
	return "Run exactly this one shell command and report its full output verbatim, then stop: curl -sS -m 12 -o /dev/null -w 'http=%{http_code}' https://" + host
}

func TestAWebFetchAllowedHostIsReachedWithNoPromptUnderManual(t *testing.T) {
	modelTurn(t)
	verifyOnce(t, func(t *testing.T) {
		el := &scripted{decision: "decline"}
		runs := profiledRuns(t, posture.Effective{Allow: []string{"WebFetch(domain:example.com)"}}, el)
		h, err := runs.Start(context.Background(), curlPrompt("example.com"), tempDir(t), "default")
		if err != nil {
			t.Fatal(err)
		}
		rec := settle(t, runs, h)
		if rec.Status != "done" || el.count() != 0 || !strings.Contains(resultText(rec), "200") {
			t.Fatalf("status %s, asks %d, result %q", rec.Status, el.count(), resultText(rec))
		}
	})
}

// Declining any approval Codex raises keeps the host unreachable whichever
// mechanism enforces it.
func TestAHostNotOnTheAllowlistIsUnreachable(t *testing.T) {
	modelTurn(t)
	verifyOnce(t, func(t *testing.T) {
		runs := profiledRuns(t, posture.Effective{Allow: []string{"WebFetch(domain:example.com)"}}, &scripted{decision: "decline"})
		h, err := runs.Start(context.Background(), curlPrompt("example.org"), tempDir(t), "default")
		if err != nil {
			t.Fatal(err)
		}
		rec := settle(t, runs, h)
		if rec.Status != "done" || strings.Contains(resultText(rec), "http=200") {
			t.Fatalf("status %s: %q", rec.Status, resultText(rec))
		}
	})
}
