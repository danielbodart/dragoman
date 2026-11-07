//go:build integration

package integration

// Long-poll follows a real turn event-driven: every wake is an event, none
// waits out the cap. Spends a model turn, so it is local only, and the
// elapsed-time check below stays out of CI.

import (
	"context"
	"testing"
	"time"

	"github.com/danielbodart/dragoman/internal/posture"
	"github.com/danielbodart/dragoman/internal/run"
)

func TestWaitForUpdateReachesCompletionEventDriven(t *testing.T) {
	modelTurn(t)
	verifyOnce(t, func(t *testing.T) {
		runs := profiledRuns(t, posture.Effective{}, &scripted{decision: "decline"})
		h, err := runs.Start(context.Background(), "Use your shell to run exactly this one command and then stop; do not run anything else: sleep 2 && echo dragoman-longpoll", tempDir(t), "dontAsk")
		if err != nil {
			t.Fatal(err)
		}
		start := time.Now()
		revision, wakeups := 0, 0
		var status run.Status
		for {
			rec, _, rev := runs.WaitForUpdate(h, revision, 100*time.Second)
			wakeups++
			revision, status = rev, rec.Status
			if status == run.Done || status == run.Failed {
				break
			}
			if time.Since(start) > 120*time.Second {
				t.Fatal("the turn did not complete in time")
			}
		}
		elapsed := time.Since(start)
		t.Logf("[long-poll] status=%s elapsed=%s wakeups=%d (a fixed 2s poller would have made about %d calls)", status, elapsed.Round(time.Millisecond), wakeups, int(elapsed/(2*time.Second))+1)
		if status != run.Done || wakeups == 0 || elapsed > 90*time.Second {
			t.Fatalf("status %s, wakeups %d, elapsed %s", status, wakeups, elapsed)
		}
	})
}
