package run

// The Codex protocol is Codex's: these fixtures are the current schema's
// messages edited the way a later codex might send them, an extra field, an
// enum value Dragoman hasn't seen, an optional field missing, a variant it
// doesn't know, and each must still work, or be passed over without stopping
// the run.

import (
	"context"
	"strings"
	"testing"

	"github.com/danielbodart/dragoman/internal/codex/codextest"
)

func TestAMilestoneWithAnExtraFieldAndAnUnknownStatusStillSurfaces(t *testing.T) {
	item := commandItem("cargo test", map[string]any{"status": "someFutureStatus", "newField": map[string]any{"x": 1}})
	delete(item, "durationMs")
	delete(item, "exitCode")
	e, ok := EventOf(itemCompleted(item, "t1", 1000))
	expectEvent(t, e, ok, map[string]any{"kind": "command", "at": 1000, "command": "cargo test", "status": "someFutureStatus"})
}

func TestAFieldOfTheWrongTypeDoesNotLoseTheEvent(t *testing.T) {
	e, ok := EventOf(itemCompleted(commandItem("make", map[string]any{"status": "failed", "exitCode": "2", "commandActions": "?"}), "t1", 1000))
	// The mistyped exit code is left zero; the failure still surfaces.
	expectEvent(t, e, ok, map[string]any{"kind": "command", "at": 1000, "command": "make", "status": "failed", "exitCode": 0})
}

func TestAnUnknownItemTypeIsPassedOver(t *testing.T) {
	e, ok := EventOf(itemCompleted(map[string]any{"type": "someFutureItem", "id": "x"}, "t1", 1000))
	expectNone(t, e, ok)
}

func TestAnUnknownGuardianActionIsShownByItsTypeName(t *testing.T) {
	e, ok := EventOf(note("item/autoApprovalReview/completed", review("denied", "someFutureRisk", map[string]any{"type": "teleport", "where": "mars"}), ptr(int64(3000))))
	expectEvent(t, e, ok, map[string]any{"kind": "autoApproval", "at": 3000, "decision": "denied", "risk": "someFutureRisk", "action": "teleport"})
}

// An unknown notification, an unknown item, a turn status Codex adds: the
// run carries on, and the next real event still lands.
func TestTheRunCarriesOnThroughWhatItDoesNotKnow(t *testing.T) {
	l, f := bridge(t, nil)
	h := l.start(t, "")
	f.Emit("someFuture/notification", map[string]any{"threadId": h, "whatever": []any{1}}, ptr(int64(1)))
	f.Emit("item/completed", itemParams(map[string]any{"type": "someFutureItem", "id": "x"}, h, 2, false), ptr(int64(2)))
	f.Emit("item/completed", itemParams(commandItem("ls", map[string]any{"status": "failed"}), h, 3, false), ptr(int64(3)))
	eventually(t, "the real event", func() bool { return len(l.status(t, h).Events) == 1 })
	f.Emit("turn/completed", map[string]any{"threadId": h, "turn": turnObject("someFutureStatus", "ok"), "extra": true}, ptr(int64(4)))
	eventually(t, "settled", func() bool { return l.status(t, h).Status == Done })
	ev := l.runs.Drain(h)
	same(t, ev[len(ev)-1], map[string]any{"kind": "result", "at": 4, "status": "someFutureStatus", "text": "ok"})
}

// An approval with fields Dragoman doesn't know, and a decision variant it
// can't offer as a string, still reaches the human with the ones it can.
func TestAnApprovalWithUnknownPartsStillAsks(t *testing.T) {
	l, f := bridge(t, nil)
	h := l.start(t, "")
	params := approvalParams(h, "rm -rf build/", nil)
	params["availableDecisions"] = []any{"accept", map[string]any{"someFutureDecision": map[string]any{}}, "decline"}
	params["someFutureField"] = "x"
	params["kind"] = "someFutureKind"
	later := replyLater(t, f, "item/commandExecution/requestApproval", params)
	eventually(t, "asked", l.elicitation.waiting)
	same(t, l.elicitation.asked()[0].Decisions, []string{"accept", "decline"})
	l.elicitation.answer(t, "accept")
	same(t, <-later, map[string]any{"decision": "accept"})
}

// Only what Dragoman needs is required: thread/start's reply with nothing
// but a thread id (and a field it doesn't know) starts the run; one without
// a thread id fails the call naming what codex sent.
func TestAThreadStartReplyIsReadForWhatDragomanNeeds(t *testing.T) {
	minimal := newLab(t, nil)
	f := codextest.New()
	f.Result("thread/start", map[string]any{"thread": map[string]any{"id": "t9", "future": 1}})
	minimal.conns = append(minimal.conns, f)
	handle, err := minimal.runs.Start(context.Background(), "p", "/repo", "")
	if err != nil || handle != "t9" {
		t.Fatalf("got %q, %v", handle, err)
	}

	noID := newLab(t, nil)
	g := codextest.New()
	g.Result("thread/start", map[string]any{"thread": map[string]any{}, "model": "m"})
	noID.conns = append(noID.conns, g)
	_, err = noID.runs.Start(context.Background(), "p", "/repo", "")
	if err == nil || !strings.Contains(err.Error(), "thread/start answered without a thread id") || !strings.Contains(err.Error(), `"model":"m"`) {
		t.Fatalf("got %v", err)
	}
}
