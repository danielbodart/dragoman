package run

import (
	"testing"
	"time"
)

func expectNone(t *testing.T, e Event, ok bool) {
	t.Helper()
	if ok {
		t.Fatalf("want no event, got %+v", e)
	}
}

func expectEvent(t *testing.T, e Event, ok bool, want any) {
	t.Helper()
	if !ok {
		t.Fatal("want an event, got none")
	}
	same(t, e, want)
}

func TestTurnStartedIsNotATimelineEvent(t *testing.T) {
	e, ok := EventOf(note("turn/started", map[string]any{"threadId": "t1", "turn": turnObject("inProgress", "")}, ptr(int64(5))))
	expectNone(t, e, ok)
}

func TestACommandStartingIsRoutine(t *testing.T) {
	e, ok := EventOf(itemStarted(commandItem("cargo test", nil), "t1", 1000))
	expectNone(t, e, ok)
}

func TestACommandThatExitsZeroIsRoutine(t *testing.T) {
	e, ok := EventOf(itemCompleted(commandItem("ls", map[string]any{"status": "completed", "exitCode": 0, "durationMs": 42}), "t1", 1000))
	expectNone(t, e, ok)
}

func TestACommandThatExitsNonZeroSurfacesCommandExitCodeAndDuration(t *testing.T) {
	e, ok := EventOf(itemCompleted(commandItem("cargo test", map[string]any{"status": "completed", "exitCode": 101, "durationMs": 42}), "t1", 2000))
	expectEvent(t, e, ok, map[string]any{"kind": "command", "at": 2000, "command": "cargo test", "status": "completed", "exitCode": 101, "durationMs": 42})
}

func TestAFailedOrDeclinedCommandIsAnEventWithoutAnExitCode(t *testing.T) {
	e, ok := EventOf(itemCompleted(commandItem("rm -rf /", map[string]any{"status": "declined"}), "t1", 1000))
	expectEvent(t, e, ok, map[string]any{"kind": "command", "at": 1000, "command": "rm -rf /", "status": "declined"})
	e, ok = EventOf(itemCompleted(commandItem("nope", map[string]any{"status": "failed"}), "t1", 1000))
	expectEvent(t, e, ok, map[string]any{"kind": "command", "at": 1000, "command": "nope", "status": "failed"})
}

func TestAFileChangeListsEachFileOnCompletionOnly(t *testing.T) {
	e, ok := EventOf(itemStarted(fileChangeItem("src/a.ts"), "t1", 1000))
	expectNone(t, e, ok)
	e, ok = EventOf(itemCompleted(fileChangeItem("src/a.ts", "b.ts"), "t1", 1000))
	expectEvent(t, e, ok, map[string]any{"kind": "edit", "at": 1000, "status": "completed", "files": []any{
		map[string]any{"path": "src/a.ts", "change": "update"}, map[string]any{"path": "b.ts", "change": "update"},
	}})
}

func TestAWebSearchIsRoutine(t *testing.T) {
	search := map[string]any{"type": "webSearch", "id": "w1", "query": "rust async traits", "action": map[string]any{"type": "search", "query": "rust async traits", "queries": nil}, "results": nil}
	e, ok := EventOf(itemStarted(search, "t1", 1000))
	expectNone(t, e, ok)
	e, ok = EventOf(itemCompleted(search, "t1", 1000))
	expectNone(t, e, ok)
}

func TestOnlyAFailedMCPToolCallIsAnEvent(t *testing.T) {
	ok := map[string]any{"type": "mcpToolCall", "id": "m1", "server": "linear", "tool": "list_issues", "status": "completed", "arguments": map[string]any{}, "appContext": nil, "pluginId": nil, "readOnlyHint": nil, "result": nil, "error": nil, "durationMs": 88}
	inProgress := map[string]any{}
	for k, v := range ok {
		inProgress[k] = v
	}
	inProgress["status"] = "inProgress"
	e, has := EventOf(itemStarted(inProgress, "t1", 1000))
	expectNone(t, e, has)
	e, has = EventOf(itemCompleted(ok, "t1", 1000))
	expectNone(t, e, has)
	failed := map[string]any{}
	for k, v := range ok {
		failed[k] = v
	}
	failed["status"], failed["error"], failed["durationMs"] = "failed", map[string]any{"message": "boom"}, nil
	e, has = EventOf(itemCompleted(failed, "t1", 1000))
	expectEvent(t, e, has, map[string]any{"kind": "mcpTool", "at": 1000, "server": "linear", "tool": "list_issues", "status": "failed", "error": "boom"})
}

func review(status string, risk any, action map[string]any) map[string]any {
	return map[string]any{
		"threadId": "t1", "turnId": "turn1", "startedAtMs": 2999, "completedAtMs": 3000,
		"reviewId": "rev1", "targetItemId": "exec-1", "decisionSource": "agent",
		"review": map[string]any{"status": status, "riskLevel": risk, "userAuthorization": nil, "rationale": nil},
		"action": action,
	}
}

func TestAnApprovedAutoApprovalIsRoutine(t *testing.T) {
	e, ok := EventOf(note("item/autoApprovalReview/completed", review("approved", "low", map[string]any{"type": "command", "source": "agent", "command": `echo "hi"`, "cwd": "/repo"}), ptr(int64(3000))))
	expectNone(t, e, ok)
}

func TestADeniedAutoApprovalDropsAnAbsentRiskAndSummarisesTheAction(t *testing.T) {
	e, ok := EventOf(note("item/autoApprovalReview/completed", review("denied", nil, map[string]any{"type": "networkAccess", "target": "https://x.com", "host": "x.com", "protocol": "https", "port": 443}), ptr(int64(3000))))
	expectEvent(t, e, ok, map[string]any{"kind": "autoApproval", "at": 3000, "decision": "denied", "action": "network x.com:443"})
}

func TestTheFirehoseProducesNoEvent(t *testing.T) {
	e, ok := EventOf(note("item/agentMessage/delta", map[string]any{"delta": "hel"}, ptr(int64(1))))
	expectNone(t, e, ok)
}

func TestAReasoningItemIsNotAMilestone(t *testing.T) {
	e, ok := EventOf(itemStarted(map[string]any{"type": "reasoning", "id": "r1", "summary": []any{}, "content": []any{}}, "t1", 1000))
	expectNone(t, e, ok)
}

func TestFallsBackToNowWhenEmittedAtMsIsAbsent(t *testing.T) {
	before := time.Now().UnixMilli()
	e, ok := EventOf(note("item/completed", itemParams(commandItem("false", map[string]any{"status": "completed", "exitCode": 1}), "t1", 0, false), nil))
	if !ok || e.At < before {
		t.Fatalf("got %+v", e)
	}
}

func TestThreadIDOfReadsAThreadScopedNotification(t *testing.T) {
	same(t, ThreadIDOf(itemStarted(commandItem("ls", nil), "abc", 1000)), "abc")
}

func TestThreadIDOfAFeedWideNotificationHasNone(t *testing.T) {
	same(t, ThreadIDOf(note("account/updated", map[string]any{}, ptr(int64(1)))), "")
}
