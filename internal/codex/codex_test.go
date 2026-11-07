package codex

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestLinesReassemblesASplitLineAndDropsATrailingPartial(t *testing.T) {
	expectLines(t, collect(t, `{"a":`, "1}\n{\"b"), `{"a":1}`)
}

// The critical regression: on a clean stdout EOF, the normal way a process
// exit presents, the read loop ends without an error. If pending requests
// weren't failed then, Request would hang forever: the hang this project
// exists to remove, recreated on subprocess death. `true` exits at once and
// sends no bytes; the initialize inside Start must fail, not hang.
func TestASubprocessThatExitsWithoutAnsweringFailsThePendingRequest(t *testing.T) {
	_, err := Start(context.Background(), []string{"true"}, nil)
	if err == nil || !(errors.Is(err, ErrExited) || errors.Is(err, ErrClosed)) {
		t.Fatalf("want an exited or closed error, got %v", err)
	}
}

// pipes is a Client over in-memory pipes, and the server's ends of them.
func pipes(t *testing.T) (*Client, *io.PipeWriter, *json.Decoder) {
	t.Helper()
	toClient, server := io.Pipe()
	fromClient, client := io.Pipe()
	c := Connect(toClient, client, nil)
	t.Cleanup(func() { server.Close(); fromClient.Close() })
	return c, server, json.NewDecoder(fromClient)
}

// A server request is answered without blocking the loop: while an approval
// sits unanswered, notifications still flow.
func TestAPendingServerRequestDoesNotStallNotifications(t *testing.T) {
	c, server, sent := pipes(t)
	release := make(chan struct{})
	c.OnServerRequest(func(r ServerRequest) (any, error) {
		<-release
		return map[string]string{"decision": "accept"}, nil
	})
	io.WriteString(server, `{"id":7,"method":"item/commandExecution/requestApproval","params":{}}`+"\n")
	io.WriteString(server, `{"method":"turn/started","params":{"threadId":"t1"},"emittedAtMs":5}`+"\n")
	n := <-c.Notifications()
	if n.Method != "turn/started" || n.EmittedAtMs == nil || *n.EmittedAtMs != 5 {
		t.Fatalf("got %+v", n)
	}
	close(release)
	var reply map[string]any
	if err := sent.Decode(&reply); err != nil {
		t.Fatal(err)
	}
	if reply["id"] != float64(7) || reply["result"].(map[string]any)["decision"] != "accept" {
		t.Fatalf("got %v", reply)
	}
	if _, has := reply["jsonrpc"]; has {
		t.Fatal("the app-server dialect carries no jsonrpc field")
	}
}

// No handler, or one that fails, is a well-formed error frame, never a
// guessed result.
func TestAFailedServerRequestIsAnErrorFrame(t *testing.T) {
	c, server, sent := pipes(t)
	io.WriteString(server, `{"id":"a","method":"item/tool/call","params":{}}`+"\n")
	var reply map[string]any
	if err := sent.Decode(&reply); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(reply["error"].(map[string]any)["message"].(string), "no server-request handler") {
		t.Fatalf("got %v", reply)
	}
	c.OnServerRequest(func(ServerRequest) (any, error) { return nil, errors.New("unsupported") })
	io.WriteString(server, `{"id":"b","method":"item/tool/call","params":{}}`+"\n")
	if err := sent.Decode(&reply); err != nil {
		t.Fatal(err)
	}
	if reply["id"] != "b" || reply["error"].(map[string]any)["code"] != float64(-32603) {
		t.Fatalf("got %v", reply)
	}
}

// A response is matched to its request, whether the id comes back as a
// number or a string; an error response fails the request with its code and
// message.
func TestRequestsAreAnsweredByID(t *testing.T) {
	c, server, sent := pipes(t)
	done := make(chan error, 2)
	var result json.RawMessage
	go func() {
		var err error
		result, err = c.Request(context.Background(), "thread/start", map[string]string{"cwd": "/repo"})
		done <- err
	}()
	var req map[string]any
	if err := sent.Decode(&req); err != nil {
		t.Fatal(err)
	}
	if req["method"] != "thread/start" || req["params"].(map[string]any)["cwd"] != "/repo" {
		t.Fatalf("got %v", req)
	}
	io.WriteString(server, `{"id":"1","result":{"thread":{"id":"t1"}}}`+"\n")
	if err := <-done; err != nil || !strings.Contains(string(result), `"t1"`) {
		t.Fatalf("got %s, %v", result, err)
	}

	go func() {
		_, err := c.Request(context.Background(), "turn/steer", nil)
		done <- err
	}()
	req = nil
	if err := sent.Decode(&req); err != nil {
		t.Fatal(err)
	}
	if _, has := req["params"]; has {
		t.Fatal("nil params are omitted")
	}
	io.WriteString(server, `{"id":2,"error":{"code":-32600,"message":"expected turn id mismatch"}}`+"\n")
	if err := <-done; err == nil || err.Error() != "-32600: expected turn id mismatch" {
		t.Fatalf("got %v", err)
	}
}

// A garbled line is skipped rather than killing the loop.
func TestAGarbledLineIsSkipped(t *testing.T) {
	c, server, _ := pipes(t)
	io.WriteString(server, "not json\n"+`{"method":"turn/started","params":{}}`+"\n")
	if n := <-c.Notifications(); n.Method != "turn/started" {
		t.Fatalf("got %+v", n)
	}
}

// When the server goes away, requests in flight fail and the feed closes.
func TestTheEndOfTheStreamFailsRequestsAndClosesTheFeed(t *testing.T) {
	c, server, sent := pipes(t)
	done := make(chan error, 1)
	go func() {
		_, err := c.Request(context.Background(), "thread/start", nil)
		done <- err
	}()
	var req map[string]any
	_ = sent.Decode(&req)
	server.Close()
	if err := <-done; !errors.Is(err, ErrExited) {
		t.Fatalf("got %v", err)
	}
	if _, open := <-c.Notifications(); open {
		t.Fatal("the feed should be closed")
	}
	if _, err := c.Request(context.Background(), "thread/start", nil); !errors.Is(err, ErrExited) {
		t.Fatalf("a request after the end fails at once, got %v", err)
	}
}
