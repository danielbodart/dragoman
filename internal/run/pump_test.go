package run

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/danielbodart/dragoman/internal/codex/codextest"
	"github.com/danielbodart/dragoman/internal/posture"
)

func settingsOf(s posture.Effective) func() posture.Effective {
	return func() posture.Effective { return s }
}

func approvalParams(threadID, command string, proposed []string) map[string]any {
	p := map[string]any{
		"kind": "command", "threadId": threadID, "turnId": "turn1", "itemId": "item1", "startedAtMs": 1000,
		"environmentId": nil, "command": command, "availableDecisions": []string{"accept", "acceptForSession", "decline"},
	}
	if proposed != nil {
		p["proposedExecpolicyAmendment"] = proposed
	}
	return p
}

func turnCompleted(f *codextest.Fake, threadID, text string) {
	f.Emit("turn/completed", map[string]any{"threadId": threadID, "turn": turnObject("completed", text)}, ptr(int64(2000)))
}

// reply drives a server request and decodes the bridge's reply.
func reply(t *testing.T, f *codextest.Fake, method string, params any) any {
	t.Helper()
	raw, err := f.EmitServerRequest(method, params)
	if err != nil {
		t.Fatal(err)
	}
	var v any
	_ = json.Unmarshal(raw, &v)
	return v
}

// replyLater drives a server request that will wait on the human.
func replyLater(t *testing.T, f *codextest.Fake, method string, params any) chan any {
	ch := make(chan any, 1)
	go func() {
		raw, err := f.EmitServerRequest(method, params)
		if err != nil {
			ch <- err.Error()
			return
		}
		var v any
		_ = json.Unmarshal(raw, &v)
		ch <- v
	}()
	return ch
}

var amendNpmTest = map[string]any{"decision": map[string]any{"acceptWithExecpolicyAmendment": map[string]any{"execpolicy_amendment": []string{"npm", "run", "test"}}}}
var decline = map[string]any{"decision": "decline"}

func TestStartReturnsAHandleBeforeTheTurnFinishes(t *testing.T) {
	l, _ := bridge(t, nil)
	h := l.start(t, "")
	same(t, h, "t1")
	if l.status(t, h).Status == Done {
		t.Fatal("not done yet")
	}
}

// Empty settings and no posture: default (Manual), so a :read-only profile,
// untrusted, and reviewer user. No sandbox enum with a profile.
func TestThreadStartMirrorsTheResolvedPosture(t *testing.T) {
	l, f := bridge(t, nil)
	l.start(t, "")
	p := f.Find("thread/start")
	same(t, p["cwd"], "/repo")
	same(t, p["approvalPolicy"], "untrusted")
	same(t, p["approvalsReviewer"], "user")
	same(t, p["permissions"], "dragoman-read-only")
	if _, has := p["sandbox"]; has {
		t.Fatal("no sandbox enum with a profile")
	}
	same(t, p["config"], map[string]any{"model_verbosity": "low"})
}

func TestAnExplicitPostureOverridesTheStaticDefault(t *testing.T) {
	l, f := bridge(t, nil)
	l.start(t, "plan")
	p := f.Find("thread/start")
	same(t, []any{p["cwd"], p["approvalPolicy"], p["permissions"]}, []any{"/repo", "on-request", "dragoman-read-only"})
	eventually(t, "turn/start sent", func() bool { return f.Find("turn/start") != nil })
	same(t, f.Find("turn/start")["collaborationMode"], map[string]any{"mode": "plan", "settings": map[string]any{"model": "test-model", "reasoning_effort": nil, "developer_instructions": nil}})
}

func TestNonPlanPosturesSendNoCollaborationMode(t *testing.T) {
	l, f := bridge(t, nil)
	l.start(t, "acceptEdits")
	eventually(t, "turn/start sent", func() bool { return f.Find("turn/start") != nil })
	if _, has := f.Find("turn/start")["collaborationMode"]; has {
		t.Fatal("no collaborationMode")
	}
}

func TestBypassPermissionsUsesTheDangerSandboxNotAProfile(t *testing.T) {
	l, f := bridge(t, nil)
	l.start(t, "bypassPermissions")
	p := f.Find("thread/start")
	same(t, p["sandbox"], "danger-full-access")
	same(t, p["approvalPolicy"], "never")
	if _, has := p["permissions"]; has {
		t.Fatal("no profile")
	}
}

func TestRuntimeWorkspaceRootsCarryCwdAndAdditionalDirectories(t *testing.T) {
	l, f := bridge(t, settingsOf(posture.Effective{SandboxEnabled: ptr(true), AdditionalDirectories: []string{"/data", "/cache"}}))
	l.start(t, "")
	same(t, f.Find("thread/start")["runtimeWorkspaceRoots"], []string{"/repo", "/data", "/cache"})
}

func TestStatusReflectsTheLatestMilestone(t *testing.T) {
	l, f := bridge(t, nil)
	h := l.start(t, "")
	at := int64(1500)
	f.Emit("item/completed", itemParams(commandItem("cargo test", map[string]any{"status": "completed", "exitCode": 101}), h, at, false), &at)
	eventually(t, "the event folded in", func() bool { return len(l.status(t, h).Events) > 0 })
	events := l.status(t, h).Events
	same(t, events[len(events)-1], map[string]any{"kind": "command", "at": 1500, "command": "cargo test", "status": "completed", "exitCode": 101})
}

// Routine and significant notifications land back to back before any poll;
// the drain hands back every significant one, oldest first, exactly once.
func TestEventsPileUpBetweenPollsAndDrainInOrder(t *testing.T) {
	l, f := bridge(t, nil)
	h := l.start(t, "")
	cmd := commandItem("curl x.com", nil)
	f.Emit("item/started", itemParams(cmd, h, 1600, true), ptr(int64(1600)))
	f.Emit("item/autoApprovalReview/completed", map[string]any{"threadId": h, "turnId": "turn1", "startedAtMs": 1600, "completedAtMs": 1601, "reviewId": "r1", "targetItemId": "c1", "decisionSource": "agent",
		"review": map[string]any{"status": "denied", "riskLevel": "high", "userAuthorization": nil, "rationale": nil}, "action": map[string]any{"type": "command", "source": "agent", "command": "curl x.com", "cwd": "/repo"}}, ptr(int64(1601)))
	f.Emit("item/completed", itemParams(commandItem("curl x.com", map[string]any{"status": "declined"}), h, 1602, false), ptr(int64(1602)))
	eventually(t, "both folded in", func() bool { return len(l.status(t, h).Events) == 2 })
	if !l.runs.HasPending(h) {
		t.Fatal("pending")
	}
	same(t, l.runs.Drain(h), []any{
		map[string]any{"kind": "autoApproval", "at": 1601, "decision": "denied", "risk": "high", "action": "curl x.com"},
		map[string]any{"kind": "command", "at": 1602, "command": "curl x.com", "status": "declined"},
	})
	if l.runs.HasPending(h) || len(l.runs.Drain(h)) != 0 {
		t.Fatal("drained exactly once")
	}
}

func TestAMirroredAllowPrefixAutoAcceptsWrappedCommandsWithoutAsking(t *testing.T) {
	l, f := bridge(t, settingsOf(posture.Effective{Allow: []string{"Bash(npm run test:*)"}}))
	h := l.start(t, "")
	same(t, reply(t, f, "item/commandExecution/requestApproval", approvalParams(h, "bash -lc 'npm run test unit'", nil)), amendNpmTest)
	if len(l.elicitation.asked()) != 0 {
		t.Fatal("asked")
	}
	later := replyLater(t, f, "item/commandExecution/requestApproval", approvalParams(h, "bash -lc 'npm run lint'", nil))
	l.elicitation.answer(t, "decline")
	same(t, <-later, decline)
}

func TestAutoAcceptUnwrapsShellFormsAndKeepsBareCommands(t *testing.T) {
	l, f := bridge(t, settingsOf(posture.Effective{Allow: []string{"Bash(npm run test:*)"}}))
	h := l.start(t, "")
	for _, c := range []string{"/bin/bash -lc 'npm run test unit'", "sh -c 'npm run test unit'", "npm run test unit"} {
		same(t, reply(t, f, "item/commandExecution/requestApproval", approvalParams(h, c, nil)), amendNpmTest)
	}
	if len(l.elicitation.asked()) != 0 {
		t.Fatal("asked")
	}
}

// proposedExecpolicyAmendment comes from Codex, the party this gate
// mediates; trusting it would fail open.
func TestCodexsOwnProposedAmendmentIsNotTrusted(t *testing.T) {
	l, f := bridge(t, settingsOf(posture.Effective{Allow: []string{"Bash(npm run test:*)"}}))
	h := l.start(t, "")
	later := replyLater(t, f, "item/commandExecution/requestApproval", approvalParams(h, "rm -rf /", []string{"npm", "run", "test", "unit"}))
	l.elicitation.answer(t, "decline")
	same(t, <-later, decline)
}

// A benign matching prefix must not carry a chained `&& rm` past the gate.
func TestAChainedCommandWhoseFirstSegmentMatchesIsNotAutoAccepted(t *testing.T) {
	l, f := bridge(t, settingsOf(posture.Effective{Allow: []string{"Bash(npm run test:*)"}}))
	h := l.start(t, "")
	later := replyLater(t, f, "item/commandExecution/requestApproval", approvalParams(h, "bash -lc 'npm run test && rm -rf /'", nil))
	l.elicitation.answer(t, "decline")
	same(t, <-later, decline)
}

func TestADeniedCommandIsPreDeclinedWithoutAsking(t *testing.T) {
	l, f := bridge(t, settingsOf(posture.Effective{Deny: []string{"Bash(curl:*)"}}))
	h := l.start(t, "")
	same(t, reply(t, f, "item/commandExecution/requestApproval", approvalParams(h, "curl https://evil.example", nil)), decline)
	if len(l.elicitation.asked()) != 0 {
		t.Fatal("asked")
	}
}

func TestDenyIsFailClosedThroughWrappersChainsAndAssignments(t *testing.T) {
	l, f := bridge(t, settingsOf(posture.Effective{Deny: []string{"Bash(curl:*)"}}))
	h := l.start(t, "")
	for _, c := range []string{"bash -lc 'curl https://evil.example'", "bash -lc 'echo ok && curl https://evil.example'", "FOO=1 curl https://evil.example"} {
		same(t, reply(t, f, "item/commandExecution/requestApproval", approvalParams(h, c, nil)), decline)
	}
	if len(l.elicitation.asked()) != 0 {
		t.Fatal("asked")
	}
}

func TestDenyWinsOverAllow(t *testing.T) {
	l, f := bridge(t, settingsOf(posture.Effective{Allow: []string{"Bash(git:*)"}, Deny: []string{"Bash(git push:*)"}}))
	h := l.start(t, "")
	same(t, reply(t, f, "item/commandExecution/requestApproval", approvalParams(h, "git push origin main", nil)), decline)
	if len(l.elicitation.asked()) != 0 {
		t.Fatal("asked")
	}
}

// The crux: an approval in front of the human stalls nothing. Status still
// answers, and notifications still fold in.
func TestAnApprovalElicitsAndStatusKeepsAnsweringWhileItWaits(t *testing.T) {
	l, f := bridge(t, nil)
	h := l.start(t, "")
	later := replyLater(t, f, "item/commandExecution/requestApproval", approvalParams(h, "rm -rf build/", nil))
	eventually(t, "the elicitation is in front of the user", l.elicitation.waiting)
	asks := l.elicitation.asked()
	if !strings.Contains(asks[0].Prompt, "rm -rf build/") {
		t.Fatalf("prompt %q", asks[0].Prompt)
	}
	same(t, asks[0].Decisions, []string{"accept", "acceptForSession", "decline"})
	same(t, l.status(t, h).Status, WaitingApproval)

	f.Emit("item/completed", itemParams(commandItem("ls", map[string]any{"status": "failed", "exitCode": 2}), h, 1600, false), ptr(int64(1600)))
	eventually(t, "a notification folds in during the approval", func() bool {
		ev := l.status(t, h).Events
		return len(ev) > 0 && ev[len(ev)-1].Kind == "command" && ev[len(ev)-1].Command == "ls"
	})

	l.elicitation.answer(t, "acceptForSession")
	same(t, <-later, map[string]any{"decision": "acceptForSession"})
	same(t, l.status(t, h).Status, Running)
}

// A fast answer flips the status back before a coarse poll sees it; the
// waiting and resolved events still drain.
func TestAHumanApprovalRidesTheLosslessTimeline(t *testing.T) {
	l, f := bridge(t, nil)
	h := l.start(t, "")
	later := replyLater(t, f, "item/commandExecution/requestApproval", approvalParams(h, "bash -lc 'python3 -c pass'", nil))
	l.elicitation.answer(t, "accept")
	<-later
	same(t, l.status(t, h).Status, Running)
	var approvals []Event
	for _, e := range l.runs.Drain(h) {
		if e.Kind == "approval" {
			approvals = append(approvals, e)
		}
	}
	what := "run `bash -lc 'python3 -c pass'`"
	same(t, approvals, []any{
		map[string]any{"kind": "approval", "at": 1000, "phase": "waiting", "what": what},
		map[string]any{"kind": "approval", "at": 1000, "phase": "resolved", "what": what, "decision": "accept"},
	})
}

func fileChangeParams(threadID string, reason string) map[string]any {
	p := map[string]any{"threadId": threadID, "turnId": "turn1", "itemId": "f1"}
	if reason != "" {
		p["reason"] = reason
	}
	return p
}

func TestAFileChangeApprovalIsElicitedThenRepliesWithTheDecision(t *testing.T) {
	l, f := bridge(t, nil)
	h := l.start(t, "")
	later := replyLater(t, f, "item/fileChange/requestApproval", fileChangeParams(h, "write outside workspace"))
	eventually(t, "asked", l.elicitation.waiting)
	asks := l.elicitation.asked()
	if !strings.Contains(asks[0].Prompt, "write files") {
		t.Fatalf("prompt %q", asks[0].Prompt)
	}
	same(t, asks[0].Decisions, []string{"accept", "acceptForSession", "decline", "cancel"})
	same(t, l.status(t, h).Status, WaitingApproval)
	l.elicitation.answer(t, "decline")
	same(t, <-later, decline)
	same(t, l.status(t, h).Status, Running)
}

func TestDontAskDeclinesAnUnmatchedCommandWithoutAsking(t *testing.T) {
	l, f := bridge(t, settingsOf(posture.Effective{DefaultMode: ptr("dontAsk")}))
	h := l.start(t, "")
	same(t, reply(t, f, "item/commandExecution/requestApproval", approvalParams(h, "curl evil.example", nil)), decline)
	if len(l.elicitation.asked()) != 0 {
		t.Fatal("asked")
	}
}

func TestDontAskDeclinesAFileEditWithoutAsking(t *testing.T) {
	l, f := bridge(t, settingsOf(posture.Effective{DefaultMode: ptr("dontAsk")}))
	h := l.start(t, "")
	same(t, reply(t, f, "item/fileChange/requestApproval", fileChangeParams(h, "")), decline)
	if len(l.elicitation.asked()) != 0 {
		t.Fatal("asked")
	}
}

func permissionsParams(threadID string, permissions any) map[string]any {
	return map[string]any{"threadId": threadID, "turnId": "turn1", "itemId": "p1", "environmentId": nil, "startedAtMs": 1000, "cwd": "/repo", "reason": "needs more room", "permissions": permissions}
}

func TestAPermissionsRequestIsElicitedAndAcceptGrantsWhatWasAsked(t *testing.T) {
	l, f := bridge(t, nil)
	h := l.start(t, "")
	requested := map[string]any{"network": map[string]any{"enabled": true}, "fileSystem": map[string]any{"read": nil, "write": []string{"/build"}}}
	later := replyLater(t, f, "item/permissions/requestApproval", permissionsParams(h, requested))
	eventually(t, "asked", l.elicitation.waiting)
	prompt := l.elicitation.asked()[0].Prompt
	for _, want := range []string{"expand its permissions", "network access", "write: /build"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt %q lacks %q", prompt, want)
		}
	}
	same(t, l.status(t, h).Status, WaitingApproval)
	l.elicitation.answer(t, "accept")
	same(t, <-later, map[string]any{"permissions": requested, "scope": "turn"})
	same(t, l.status(t, h).Status, Running)
}

func TestAPermissionsRequestDeclinedGrantsNothing(t *testing.T) {
	l, f := bridge(t, nil)
	h := l.start(t, "")
	later := replyLater(t, f, "item/permissions/requestApproval", permissionsParams(h, map[string]any{"network": map[string]any{"enabled": true}, "fileSystem": nil}))
	l.elicitation.answer(t, "decline")
	same(t, <-later, map[string]any{"permissions": map[string]any{}, "scope": "turn"})
}

func TestDontAskRefusesAPermissionsRequestWithoutAsking(t *testing.T) {
	l, f := bridge(t, settingsOf(posture.Effective{DefaultMode: ptr("dontAsk")}))
	h := l.start(t, "")
	same(t, reply(t, f, "item/permissions/requestApproval", permissionsParams(h, map[string]any{"network": map[string]any{"enabled": true}, "fileSystem": nil})),
		map[string]any{"permissions": map[string]any{}, "scope": "turn"})
	if len(l.elicitation.asked()) != 0 {
		t.Fatal("asked")
	}
}

func TestAcceptEditsStillAsksForAnEscapedFileEdit(t *testing.T) {
	l, f := bridge(t, settingsOf(posture.Effective{DefaultMode: ptr("acceptEdits")}))
	h := l.start(t, "")
	later := replyLater(t, f, "item/fileChange/requestApproval", fileChangeParams(h, ""))
	eventually(t, "routed to the human, not auto-accepted", l.elicitation.waiting)
	l.elicitation.answer(t, "decline")
	same(t, <-later, decline)
}

func TestCurrentTimeReadIsAnsweredWithTheTime(t *testing.T) {
	l, f := bridge(t, nil)
	l.start(t, "")
	before := time.Now().Unix()
	got := reply(t, f, "currentTime/read", map[string]any{}).(map[string]any)
	if int64(got["currentTimeAt"].(float64)) < before {
		t.Fatalf("got %v", got)
	}
}

// A wrong-shaped result is worse than an error frame the server can act on.
func TestAnUnsupportedServerRequestIsAnErrorFrame(t *testing.T) {
	l, f := bridge(t, nil)
	l.start(t, "")
	for _, m := range []string{"account/chatgptAuthTokens/refresh", "item/tool/call", "execCommandApproval"} {
		_, err := f.EmitServerRequest(m, map[string]any{})
		if err == nil || !strings.Contains(err.Error(), "unsupported server request") {
			t.Fatalf("%s: got %v", m, err)
		}
	}
}

func TestACompletedTurnCarriesTheFinalMessageAsTheResult(t *testing.T) {
	l, f := bridge(t, nil)
	h := l.start(t, "")
	turnCompleted(f, h, "all done")
	eventually(t, "done", func() bool { return l.status(t, h).Status == Done })
	for _, e := range l.runs.Drain(h) {
		if e.Kind == "result" {
			same(t, *e.Text, "all done")
			return
		}
	}
	t.Fatal("no result")
}

// Long-poll: event-driven, not on a timer. The waits below use caps of an
// hour: if a wake were missed the test would hang, not pass.
func TestWaitForUpdateWakesWhenTheRunChanges(t *testing.T) {
	l, f := bridge(t, nil)
	h := l.start(t, "")
	l.started(t, h)
	since := l.runs.Revision(h)
	done := make(chan Record, 1)
	go func() { r, _, _ := l.runs.WaitForUpdate(h, since, time.Hour); done <- r }()
	turnCompleted(f, h, "all done")
	r := <-done
	same(t, r.Status, Done)
	if l.runs.Revision(h) <= since {
		t.Fatal("the revision advanced")
	}
}

func TestWaitForUpdateWakesOnAHeartbeatEvent(t *testing.T) {
	l, f := bridge(t, nil)
	h := l.start(t, "")
	l.started(t, h)
	l.runs.Drain(h)
	since := l.runs.Revision(h)
	f.Emit("item/completed", itemParams(commandItem("ls", map[string]any{"status": "failed", "exitCode": 2}), h, 1600, false), ptr(int64(1600)))
	for {
		r, _, rev := l.runs.WaitForUpdate(h, since, time.Hour)
		if n := len(r.Events); n > 0 {
			same(t, r.Events[n-1].Command, "ls")
			return
		}
		since = rev
	}
}

// Token usage and rate limits bump the revision but carry no event; the wait
// sleeps through them and wakes on the next event.
func TestWaitForEventsSleepsThroughTelemetryAndWakesOnAnEvent(t *testing.T) {
	l, f := bridge(t, nil)
	h := l.start(t, "")
	l.started(t, h)
	l.runs.Drain(h)
	woke := make(chan struct{})
	go func() { l.runs.WaitForEvents(bg, h, time.Hour); close(woke) }()
	breakdown := map[string]any{"totalTokens": 10, "inputTokens": 10, "cachedInputTokens": 0, "cacheWriteInputTokens": 0, "outputTokens": 0, "reasoningOutputTokens": 0}
	f.Emit("thread/tokenUsage/updated", map[string]any{"threadId": h, "turnId": "turn1", "tokenUsage": map[string]any{"total": breakdown, "last": breakdown, "modelContextWindow": 100}}, ptr(int64(1700)))
	eventually(t, "the telemetry folded in", func() bool { return l.status(t, h).Ctx != nil })
	l.runs.Bump(h)
	select {
	case <-woke:
		t.Fatal("woke on telemetry")
	default:
	}
	turnCompleted(f, h, "all done")
	<-woke
	ev := l.runs.Drain(h)
	same(t, ev[len(ev)-1].Kind, "result")
	same(t, *ev[len(ev)-1].Text, "all done")
}

func TestWaitForEventsReturnsAfterTheTimeoutOnAQuietRun(t *testing.T) {
	l, _ := bridge(t, nil)
	h := l.start(t, "")
	l.started(t, h)
	l.runs.Drain(h)
	l.runs.WaitForEvents(bg, h, 40*time.Millisecond)
	if l.runs.HasPending(h) {
		t.Fatal("nothing pending")
	}
}

// Even with a `since` far ahead, a terminal run returns at once.
func TestWaitForUpdateReturnsImmediatelyWhenTerminal(t *testing.T) {
	l, f := bridge(t, nil)
	h := l.start(t, "")
	turnCompleted(f, h, "done")
	eventually(t, "done", func() bool { return l.status(t, h).Status == Done })
	r, _, _ := l.runs.WaitForUpdate(h, 9999, time.Hour)
	same(t, r.Status, Done)
}

func TestWaitForUpdateReturnsAfterTheTimeoutWhenNothingChanges(t *testing.T) {
	l, _ := bridge(t, nil)
	h := l.start(t, "")
	l.started(t, h)
	since := l.runs.Revision(h)
	_, _, rev := l.runs.WaitForUpdate(h, since, 40*time.Millisecond)
	same(t, rev, since)
}

func tokenUsage(f *codextest.Fake, h string, total int, window any) {
	b := map[string]any{"totalTokens": total, "inputTokens": total, "cachedInputTokens": 0, "cacheWriteInputTokens": 0, "outputTokens": 0, "reasoningOutputTokens": 0}
	f.Emit("thread/tokenUsage/updated", map[string]any{"threadId": h, "turnId": "turn1", "tokenUsage": map[string]any{"total": b, "last": b, "modelContextWindow": window}}, ptr(int64(1800)))
}

func rateLimitsNote(f *codextest.Fake, primaryMins, primaryPct float64, secondary map[string]any) {
	f.Emit("account/rateLimits/updated", map[string]any{"rateLimits": map[string]any{
		"limitId": nil, "limitName": nil, "primary": map[string]any{"usedPercent": primaryPct, "windowDurationMins": primaryMins, "resetsAt": nil},
		"secondary": secondary, "credits": nil, "individualLimit": nil, "spendControlReached": nil, "planType": nil, "rateLimitReachedType": nil,
	}}, ptr(int64(1801)))
}

func limitWindow(mins, pct float64) map[string]any {
	return map[string]any{"usedPercent": pct, "windowDurationMins": mins, "resetsAt": nil}
}

func TestTokenUsageSetsCtxAsAPercentageOfTheWindow(t *testing.T) {
	l, f := bridge(t, nil)
	h := l.start(t, "")
	tokenUsage(f, h, 50000, 200000)
	eventually(t, "ctx", func() bool { return l.status(t, h).Ctx != nil })
	same(t, *l.status(t, h).Ctx, 25)
}

func TestAnUnknownContextWindowLeavesCtxUnset(t *testing.T) {
	l, f := bridge(t, nil)
	h := l.start(t, "")
	tokenUsage(f, h, 50000, nil)
	f.Emit("item/completed", itemParams(commandItem("x", map[string]any{"status": "failed"}), h, 1, false), ptr(int64(1)))
	eventually(t, "the next notification folded in", func() bool { return len(l.status(t, h).Events) > 0 })
	if l.status(t, h).Ctx != nil {
		t.Fatal("ctx should be unset")
	}
}

// Classified by windowDurationMins, not by position.
func TestRateLimitWindowsAreLabelledByDuration(t *testing.T) {
	l, f := bridge(t, nil)
	l.start(t, "")
	rateLimitsNote(f, 10080, 18, limitWindow(300, 42))
	eventually(t, "limits", func() bool { return l.runs.AccountLimits().FiveHour != nil })
	same(t, l.runs.AccountLimits(), map[string]any{"5h": 42, "7d": 18})
}

func TestRateLimitsAndCtxAccumulateSeparately(t *testing.T) {
	l, f := bridge(t, nil)
	h := l.start(t, "")
	rateLimitsNote(f, 300, 42, limitWindow(10080, 18))
	tokenUsage(f, h, 120000, 200000)
	eventually(t, "both", func() bool { return l.runs.AccountLimits().FiveHour != nil && l.status(t, h).Ctx != nil })
	same(t, l.runs.AccountLimits(), map[string]any{"5h": 42, "7d": 18})
	same(t, *l.status(t, h).Ctx, 60)
}

func TestASparseRateLimitUpdateMergesWithoutClearingTheOtherWindow(t *testing.T) {
	l, f := bridge(t, nil)
	l.start(t, "")
	rateLimitsNote(f, 300, 42, limitWindow(10080, 18))
	eventually(t, "limits", func() bool { return l.runs.AccountLimits().SevenDay != nil })
	rateLimitsNote(f, 300, 55, nil)
	eventually(t, "the update", func() bool { u := l.runs.AccountLimits(); return u.FiveHour != nil && *u.FiveHour == 55 })
	same(t, l.runs.AccountLimits(), map[string]any{"5h": 55, "7d": 18})
}

func agentMessageCompleted(f *codextest.Fake, h, text string) {
	f.Emit("item/completed", itemParams(agentMessageItem(text), h, 1700, false), ptr(int64(1700)))
}

func TestAMidRunAgentMessageIsAMessageEvent(t *testing.T) {
	l, f := bridge(t, nil)
	h := l.start(t, "")
	agentMessageCompleted(f, h, "I'll start with the parser.")
	eventually(t, "message", func() bool { return len(l.status(t, h).Events) > 0 })
	same(t, l.runs.Drain(h), []any{map[string]any{"at": 1700, "kind": "message", "text": "I'll start with the parser."}})
	if l.status(t, h).Status == Done {
		t.Fatal("a message is not terminal")
	}
}

// The final message streams, then turn/completed carries the same text, in
// the same poll window: one event, upgraded in place, keeping its own time.
func TestTheFinalMessageIsNotDeliveredTwice(t *testing.T) {
	l, f := bridge(t, nil)
	h := l.start(t, "")
	agentMessageCompleted(f, h, "all done")
	turnCompleted(f, h, "all done")
	eventually(t, "done", func() bool { return l.status(t, h).Status == Done })
	same(t, l.runs.Drain(h), []any{map[string]any{"kind": "result", "at": 1700, "status": "completed", "text": "all done"}})
}

func TestAMessageDrainedBeforeCompletionStillYieldsTheResult(t *testing.T) {
	l, f := bridge(t, nil)
	h := l.start(t, "")
	agentMessageCompleted(f, h, "all done")
	eventually(t, "message", func() bool { return len(l.status(t, h).Events) > 0 })
	same(t, l.runs.Drain(h)[0].Kind, "message")
	turnCompleted(f, h, "all done")
	eventually(t, "done", func() bool { return l.status(t, h).Status == Done })
	same(t, l.runs.Drain(h), []any{map[string]any{"kind": "result", "at": 2000, "status": "completed", "text": "all done"}})
}
