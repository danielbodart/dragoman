package run

// The peer-agent lifecycle tools, cancel, steer, continue and review, over
// the fake app-server. Each provisions a fresh conn per run, as production
// does, so a continuation resumes on its own connection.

import (
	"context"
	"strings"
	"testing"

	"github.com/danielbodart/dragoman/internal/protocol"
)

func contains(t *testing.T, s, sub string) {
	t.Helper()
	if !strings.Contains(s, sub) {
		t.Fatalf("%q lacks %q", s, sub)
	}
}

var bg = context.Background()

func TestCancelInterruptsTheActiveTurn(t *testing.T) {
	l := newLab(t, nil)
	f := l.conn("t1", "turn1")
	h := l.start(t, "")
	l.started(t, h)
	msg, err := l.runs.Cancel(bg, h)
	if err != nil {
		t.Fatal(err)
	}
	contains(t, msg, "Requested cancel")
	same(t, f.Find("turn/interrupt"), map[string]any{"threadId": "t1", "turnId": "turn1"})
}

func TestCancelAnUnknownHandleIsAMessage(t *testing.T) {
	l := newLab(t, nil)
	msg, _ := l.runs.Cancel(bg, "nope")
	contains(t, msg, `No Codex task with handle "nope"`)
}

func TestCancelAFinishedTaskHasNothingToCancel(t *testing.T) {
	l := newLab(t, nil)
	f := l.conn("t1", "turn1")
	h := l.start(t, "")
	turnCompleted(f, "t1", "all done")
	eventually(t, "done", func() bool { return l.status(t, h).Status == Done })
	msg, _ := l.runs.Cancel(bg, h)
	contains(t, msg, "already finished")
}

func TestSteerInjectsTextAndAdoptsTheRepliesTurnID(t *testing.T) {
	l := newLab(t, nil)
	f := l.conn("t1", "turn1")
	f.Result("turn/steer", map[string]any{"turnId": "turn2"})
	h := l.start(t, "")
	l.started(t, h)
	msg, _ := l.runs.Steer(bg, h, "also check the Windows path")
	contains(t, msg, "Steered")
	// text_elements is optional in the schema: an empty list is omitted.
	same(t, f.Find("turn/steer"), map[string]any{
		"threadId":       "t1",
		"input":          []any{map[string]any{"type": "text", "text": "also check the Windows path"}},
		"expectedTurnId": "turn1",
	})
	same(t, l.status(t, h).TurnID, "turn2")
}

func TestAStaleTurnRejectionIsAStatusLineNeverAnError(t *testing.T) {
	l := newLab(t, nil)
	f := l.conn("t1", "turn1")
	f.Fail("turn/steer", "expected turn id mismatch")
	h := l.start(t, "")
	l.started(t, h)
	msg, err := l.runs.Steer(bg, h, "nudge")
	if err != nil {
		t.Fatal(err)
	}
	contains(t, msg, "Could not steer")
	contains(t, msg, "expected turn id mismatch")
}

func TestContinueResumesOnAFreshConnAndReMirrors(t *testing.T) {
	l := newLab(t, nil)
	first := l.conn("t1", "turn1")
	h := l.start(t, "")
	turnCompleted(first, "t1", "all done")
	eventually(t, "done", func() bool { return l.status(t, h).Status == Done })

	second := l.conn("t1", "turn2")
	msg, err := l.runs.ContinueRun(bg, h, "now update the tests", "")
	if err != nil {
		t.Fatal(err)
	}
	contains(t, msg, "Continuing")
	resume := second.Find("thread/resume")
	same(t, resume["threadId"], "t1")
	same(t, resume["cwd"], "/repo")
	eventually(t, "the new turn", func() bool { return l.status(t, h).TurnID == "turn2" })
	if second.Find("turn/start") == nil {
		t.Fatal("a new turn was started on the resumed thread")
	}
	same(t, l.status(t, h).Status, Running)
}

func TestAStillRunningTaskIsSteeredNotContinued(t *testing.T) {
	l := newLab(t, nil)
	l.conn("t1", "turn1")
	h := l.start(t, "")
	l.started(t, h)
	msg, _ := l.runs.ContinueRun(bg, h, "next", "")
	contains(t, msg, "still running")
}

func TestContinueAnUnknownHandleIsAMessage(t *testing.T) {
	l := newLab(t, nil)
	msg, _ := l.runs.ContinueRun(bg, "nope", "next", "")
	contains(t, msg, `No Codex task with handle "nope"`)
}

func TestReviewStartsAReviewTurnOnAFreshThreadInline(t *testing.T) {
	l := newLab(t, nil)
	f := l.conn("t1", "turn1")
	f.Result("review/start", map[string]any{"turn": map[string]any{"id": "rev1"}, "reviewThreadId": "t1"})
	h, err := l.runs.Review(bg, "/repo", protocol.ReviewTarget{UncommittedChanges: &protocol.UncommittedChangesReviewTarget{}}, "")
	if err != nil {
		t.Fatal(err)
	}
	same(t, h, "t1")
	eventually(t, "the review turn", func() bool { return l.status(t, h).TurnID == "rev1" })
	if f.Find("thread/start") == nil {
		t.Fatal("thread/start")
	}
	same(t, f.Find("review/start"), map[string]any{"threadId": "t1", "target": map[string]any{"type": "uncommittedChanges"}, "delivery": "inline"})
}

func TestTheReviewsFindingsSurfaceAsTheResult(t *testing.T) {
	l := newLab(t, nil)
	f := l.conn("t1", "turn1")
	f.Result("review/start", map[string]any{"turn": map[string]any{"id": "rev1"}, "reviewThreadId": "t1"})
	h, _ := l.runs.Review(bg, "/repo", protocol.ReviewTarget{BaseBranch: &protocol.BaseBranchReviewTarget{Branch: "main"}}, "")
	turnCompleted(f, "t1", "all done")
	eventually(t, "done", func() bool { return l.status(t, h).Status == Done })
	for _, e := range l.runs.Drain(h) {
		if e.Kind == "result" {
			same(t, *e.Text, "all done")
			return
		}
	}
	t.Fatal("no result")
}
