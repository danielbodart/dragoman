package mcp

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/danielbodart/dragoman/internal/run"
)

// session is a Server over pipes, and the client's ends.
type session struct {
	in  *io.PipeWriter
	out *json.Decoder
}

func newSession(t *testing.T, call CallTool) (*Server, *session) {
	t.Helper()
	clientIn, serverOut := io.Pipe()
	serverIn, clientOut := io.Pipe()
	s := NewServer(ToolsJSON, call, nil)
	go s.Serve(context.Background(), serverIn, serverOut)
	t.Cleanup(func() { clientOut.Close(); serverOut.Close() })
	return s, &session{in: clientOut, out: json.NewDecoder(clientIn)}
}

func (c *session) send(t *testing.T, line string) {
	t.Helper()
	if _, err := io.WriteString(c.in, line+"\n"); err != nil {
		t.Fatal(err)
	}
}

func (c *session) next(t *testing.T) map[string]any {
	t.Helper()
	var m map[string]any
	if err := c.out.Decode(&m); err != nil {
		t.Fatal(err)
	}
	return m
}

func initialize(t *testing.T, c *session, version, capabilities string) map[string]any {
	c.send(t, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"`+version+`","capabilities":`+capabilities+`,"clientInfo":{"name":"t","version":"0"}}}`)
	c.send(t, `{"jsonrpc":"2.0","method":"notifications/initialized"}`)
	return c.next(t)["result"].(map[string]any)
}

func noCall(context.Context, string, json.RawMessage, map[string]any) (any, bool) { return nil, false }

func TestInitializeEchoesAVersionItSpeaks(t *testing.T) {
	_, c := newSession(t, noCall)
	r := initialize(t, c, "2025-06-18", `{}`)
	if r["protocolVersion"] != "2025-06-18" || r["serverInfo"].(map[string]any)["name"] != "dragoman" {
		t.Fatalf("got %v", r)
	}
	if _, ok := r["capabilities"].(map[string]any)["tools"]; !ok {
		t.Fatalf("got %v", r)
	}
}

// MCP is not Dragoman's format: a version it has not heard of (a newer one,
// or nonsense) is answered with the newest it speaks, never refused; extra
// fields anywhere are ignored.
func TestInitializeIsLenient(t *testing.T) {
	for _, v := range []string{"2026-07-28", "2099-01-01", ""} {
		_, c := newSession(t, noCall)
		c.send(t, `{"jsonrpc":"2.0","id":1,"method":"initialize","extra":true,"params":{"protocolVersion":"`+v+`","capabilities":{"someFuture":{}},"clientInfo":{"name":"t","version":"0","nickname":"x"},"more":[1]}}`)
		if r := c.next(t)["result"].(map[string]any); r["protocolVersion"] != "2025-11-25" {
			t.Fatalf("%q: got %v", v, r)
		}
	}
}

func TestToolsListIsTheEmbeddedTools(t *testing.T) {
	_, c := newSession(t, noCall)
	initialize(t, c, "2025-11-25", `{}`)
	c.send(t, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	tools := c.next(t)["result"].(map[string]any)["tools"].([]any)
	var names []string
	for _, tool := range tools {
		names = append(names, tool.(map[string]any)["name"].(string))
	}
	if strings.Join(names, ",") != "codex_run,diagnostics,codex_status,codex_steer,codex_cancel,codex_review,codex_continue" {
		t.Fatalf("got %v", names)
	}
}

// The payload rides structuredContent, and content carries the same object
// serialized. _meta reaches the tool.
func TestToolsCallWrapsTheStructuredResult(t *testing.T) {
	_, c := newSession(t, func(_ context.Context, name string, args json.RawMessage, meta map[string]any) (any, bool) {
		return map[string]any{"name": name, "args": json.RawMessage(args), "id": meta["claudecode/toolUseId"]}, name == "bad"
	})
	initialize(t, c, "2025-11-25", `{}`)
	c.send(t, `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"codex_status","arguments":{"handle":"h"},"_meta":{"claudecode/toolUseId":"toolu_1"}}}`)
	r := c.next(t)["result"].(map[string]any)
	want := map[string]any{"name": "codex_status", "args": map[string]any{"handle": "h"}, "id": "toolu_1"}
	if b, _ := json.Marshal(r["structuredContent"]); string(b) != mustJSON(want) {
		t.Fatalf("got %s", b)
	}
	if text := r["content"].([]any)[0].(map[string]any)["text"]; text != mustJSON(want) {
		t.Fatalf("got %v", text)
	}
	if _, isError := r["isError"]; isError {
		t.Fatal("not an error")
	}
	c.send(t, `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"bad"}}`)
	if c.next(t)["result"].(map[string]any)["isError"] != true {
		t.Fatal("an error")
	}
}

func mustJSON(v any) string { b, _ := json.Marshal(v); return string(b) }

func TestAnUnknownMethodIsMethodNotFoundAndPingAnswers(t *testing.T) {
	_, c := newSession(t, noCall)
	c.send(t, `{"jsonrpc":"2.0","id":5,"method":"resources/list"}`)
	if e := c.next(t)["error"].(map[string]any); e["code"] != float64(-32601) {
		t.Fatalf("got %v", e)
	}
	c.send(t, `{"jsonrpc":"2.0","method":"notifications/someFuture","params":{}}`)
	c.send(t, `{"jsonrpc":"2.0","id":6,"method":"ping"}`)
	if m := c.next(t); m["id"] != float64(6) {
		t.Fatalf("got %v", m)
	}
}

// Requests are handled concurrently: a long-polling call never holds up
// another, nor the answer to an elicitation.
func TestACallInFlightDoesNotHoldUpAnother(t *testing.T) {
	release := make(chan struct{})
	_, c := newSession(t, func(_ context.Context, name string, _ json.RawMessage, _ map[string]any) (any, bool) {
		if name == "slow" {
			<-release
		}
		return map[string]any{"name": name}, false
	})
	initialize(t, c, "2025-11-25", `{}`)
	c.send(t, `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"slow"}}`)
	c.send(t, `{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"fast"}}`)
	if m := c.next(t); m["id"] != float64(8) {
		t.Fatalf("got %v first", m)
	}
	close(release)
	if m := c.next(t); m["id"] != float64(7) {
		t.Fatalf("got %v", m)
	}
}

// The approval path: elicitation/create sent from outside any request, the
// reply routed back to it.
func TestElicitationFromOutsideARequest(t *testing.T) {
	s, c := newSession(t, noCall)
	initialize(t, c, "2025-11-25", `{"elicitation":{}}`)
	got := make(chan string, 1)
	go func() {
		d, err := Elicitation{Server: s}.Ask(context.Background(), run.Approval{Prompt: "Codex wants to run `ls`", Decisions: []string{"accept", "decline"}})
		if err != nil {
			got <- "error: " + err.Error()
			return
		}
		got <- d
	}()
	req := c.next(t)
	params := req["params"].(map[string]any)
	if req["method"] != "elicitation/create" || params["message"] != "Codex wants to run `ls`" || params["mode"] != "form" {
		t.Fatalf("got %v", req)
	}
	enum := params["requestedSchema"].(map[string]any)["properties"].(map[string]any)["decision"].(map[string]any)["enum"]
	if mustJSON(enum) != `["accept","decline"]` {
		t.Fatalf("got %v", enum)
	}
	c.send(t, `{"jsonrpc":"2.0","id":`+mustJSON(req["id"])+`,"result":{"action":"accept","content":{"decision":"decline"}}}`)
	if d := <-got; d != "decline" {
		t.Fatalf("got %q", d)
	}
}

// Dismissing the prompt, or an answer that is not one of the decisions, is
// Codex's "cancel".
func TestADismissedOrUnexpectedAnswerIsCancel(t *testing.T) {
	for _, result := range []string{`{"action":"decline"}`, `{"action":"cancel"}`, `{"action":"accept","content":{"decision":"rm -rf"}}`, `{"action":"accept"}`} {
		s, c := newSession(t, noCall)
		initialize(t, c, "2025-11-25", `{"elicitation":{"form":{}}}`)
		got := make(chan string, 1)
		go func() {
			d, _ := Elicitation{Server: s}.Ask(context.Background(), run.Approval{Prompt: "p", Decisions: []string{"accept"}})
			got <- d
		}()
		req := c.next(t)
		c.send(t, `{"jsonrpc":"2.0","id":`+mustJSON(req["id"])+`,"result":`+result+`}`)
		if d := <-got; d != "cancel" {
			t.Fatalf("%s: got %q", result, d)
		}
	}
}

func TestElicitationNeedsTheClientToSupportIt(t *testing.T) {
	for _, caps := range []string{`{}`, `{"elicitation":{"url":{}}}`} {
		s, c := newSession(t, noCall)
		initialize(t, c, "2025-11-25", caps)
		if _, err := (Elicitation{Server: s}).Ask(context.Background(), run.Approval{Prompt: "p"}); err == nil {
			t.Fatalf("%s: want an error", caps)
		}
	}
}

// When Claude Code goes away, an elicitation in flight fails rather than
// hanging the approval forever.
func TestAnElicitationInFlightFailsWhenTheClientGoesAway(t *testing.T) {
	s, c := newSession(t, noCall)
	initialize(t, c, "2025-11-25", `{"elicitation":{}}`)
	errs := make(chan error, 1)
	go func() {
		_, err := Elicitation{Server: s}.Ask(context.Background(), run.Approval{Prompt: "p"})
		errs <- err
	}()
	c.next(t)
	c.in.Close()
	select {
	case err := <-errs:
		if err == nil {
			t.Fatal("want an error")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the elicitation hung")
	}
}
