package run

import (
	"context"
	"encoding/json"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/danielbodart/dragoman/internal/codex"
	"github.com/danielbodart/dragoman/internal/codex/codextest"
	"github.com/danielbodart/dragoman/internal/posture"
)

func ptr[T any](v T) *T { return &v }

// note builds a notification as Codex would send it.
func note(method string, params any, emittedAtMs *int64) codex.Notification {
	b, _ := json.Marshal(params)
	return codex.Notification{Method: method, Params: b, EmittedAtMs: emittedAtMs}
}

// commandItem is a commandExecution ThreadItem with harmless defaults, so a
// test states only the field under test.
func commandItem(command string, extra map[string]any) map[string]any {
	item := map[string]any{
		"type": "commandExecution", "id": "i1", "pluginId": nil, "scriptPath": nil, "command": command,
		"cwd": "/repo", "processId": nil, "source": "agent", "status": "inProgress", "commandActions": []any{},
		"aggregatedOutput": nil, "exitCode": nil, "durationMs": nil,
	}
	for k, v := range extra {
		item[k] = v
	}
	return item
}

func fileChangeItem(paths ...string) map[string]any {
	changes := []any{}
	for _, p := range paths {
		changes = append(changes, map[string]any{"path": p, "kind": map[string]any{"type": "update", "move_path": nil}, "diff": ""})
	}
	return map[string]any{"type": "fileChange", "id": "i2", "changes": changes, "status": "completed"}
}

func agentMessageItem(text string) map[string]any {
	return map[string]any{"type": "agentMessage", "id": "am1", "text": text, "phase": nil, "memoryCitation": nil, "delivery": nil}
}

func itemParams(item map[string]any, threadID string, at int64, started bool) map[string]any {
	p := map[string]any{"item": item, "threadId": threadID, "turnId": "turn1"}
	if started {
		p["startedAtMs"] = at
	} else {
		p["completedAtMs"] = at
	}
	return p
}

func itemStarted(item map[string]any, threadID string, at int64) codex.Notification {
	return note("item/started", itemParams(item, threadID, at, true), &at)
}

func itemCompleted(item map[string]any, threadID string, at int64) codex.Notification {
	return note("item/completed", itemParams(item, threadID, at, false), &at)
}

func turnObject(status, text string) map[string]any {
	items := []any{}
	if text != "" {
		items = append(items, map[string]any{"type": "agentMessage", "id": "m1", "text": text, "phase": nil, "memoryCitation": nil, "delivery": nil})
	}
	return map[string]any{"id": "turn1", "items": items, "itemsView": "complete", "status": status, "error": nil, "startedAt": nil, "completedAt": nil, "durationMs": nil}
}

// same compares as JSON, the way the TypeScript tests compared plain
// objects: what goes on the wire is what matters.
func same(t *testing.T, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(asJSON(t, got), asJSON(t, want)) {
		g, _ := json.Marshal(got)
		w, _ := json.Marshal(want)
		t.Fatalf("got  %s\nwant %s", g, w)
	}
}

func asJSON(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	_ = json.Unmarshal(b, &out)
	return out
}

// eventually waits for cond, the stand-in for the TypeScript's
// `await Bun.sleep(1)` while the pump folds a notification in. It is a guard
// against a hang, not a measure of speed.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("never: %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}

// fakeElicitation holds every ask until the test answers it: the stand-in
// for "the human hasn't clicked yet".
type fakeElicitation struct {
	mu      sync.Mutex
	asks    []Approval
	pending []chan string
}

func (f *fakeElicitation) Ask(_ context.Context, a Approval) (string, error) {
	ch := make(chan string, 1)
	f.mu.Lock()
	f.asks = append(f.asks, a)
	f.pending = append(f.pending, ch)
	f.mu.Unlock()
	return <-ch, nil
}

func (f *fakeElicitation) waiting() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.pending) > 0
}

func (f *fakeElicitation) asked() []Approval {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Approval(nil), f.asks...)
}

// answer answers the oldest unanswered ask, as the user's click would.
func (f *fakeElicitation) answer(t *testing.T, decision string) {
	t.Helper()
	eventually(t, "an elicitation is waiting", f.waiting)
	f.mu.Lock()
	ch := f.pending[0]
	f.pending = f.pending[1:]
	f.mu.Unlock()
	ch <- decision
}

type lab struct {
	runs        *Runs
	elicitation *fakeElicitation
	conns       []*codextest.Fake
	mu          sync.Mutex
}

// newLab is a registry that hands out the queued fakes in order, one per
// provision, as production spawns one app-server per run.
func newLab(t *testing.T, settings func() posture.Effective) *lab {
	l := &lab{elicitation: &fakeElicitation{}}
	if settings == nil {
		settings = func() posture.Effective { return posture.Effective{} }
	}
	pump := &Pump{Elicitation: l.elicitation}
	provision := func(context.Context, posture.Policy) (Provisioned, error) {
		l.mu.Lock()
		defer l.mu.Unlock()
		if len(l.conns) == 0 {
			t.Fatal("test provisioned no conn")
		}
		f := l.conns[0]
		l.conns = l.conns[1:]
		return Provisioned{Conn: f.Client, Cleanup: func() { _ = f.Client.Close() }}, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	l.runs = New(provision, func(c codex.Conn) { pump.Start(ctx, c) }, func() int64 { return 1000 }, settings, nil)
	pump.Runs = l.runs
	return l
}

// conn queues a fake answering thread/start, thread/resume and turn/start.
func (l *lab) conn(threadID, turnID string) *codextest.Fake {
	f := codextest.New()
	f.Result("thread/start", map[string]any{"thread": map[string]any{"id": threadID}, "model": "test-model", "reasoningEffort": nil})
	f.Result("thread/resume", map[string]any{"thread": map[string]any{"id": threadID}, "model": "test-model", "reasoningEffort": nil, "cwd": "/repo", "runtimeWorkspaceRoots": []any{}})
	f.Result("turn/start", map[string]any{"turn": map[string]any{"id": turnID}})
	l.mu.Lock()
	l.conns = append(l.conns, f)
	l.mu.Unlock()
	return f
}

// bridge is a lab with one conn, started on a run.
func bridge(t *testing.T, settings func() posture.Effective) (*lab, *codextest.Fake) {
	l := newLab(t, settings)
	return l, l.conn("t1", "turn1")
}

func (l *lab) start(t *testing.T, posture string) string {
	t.Helper()
	h, err := l.runs.Start(context.Background(), "do the thing", "/repo", posture)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func (l *lab) status(t *testing.T, h string) Record {
	t.Helper()
	r, ok := l.runs.Status(h)
	if !ok {
		t.Fatalf("no run %s", h)
	}
	return r
}

// started waits for the turn/start reply to be folded in.
func (l *lab) started(t *testing.T, h string) {
	t.Helper()
	eventually(t, "the turn started", func() bool { r, _ := l.runs.Status(h); return r.TurnID != "" })
}
