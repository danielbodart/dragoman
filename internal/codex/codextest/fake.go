// Package codextest is the Codex app-server as an in-process fake, speaking
// the real NDJSON wire over a pair of io.Pipes to a real codex.Client, so the
// whole bridge runs in a test with no daemon. Tests set canned results and
// failures per method, assert on the requests it recorded, push
// notifications with Emit, and drive server requests (approvals) with
// EmitServerRequest, which waits for the bridge's reply.
package codextest

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"sync"

	"github.com/danielbodart/dragoman/internal/codex"
)

// Request is one client to server request the fake received.
type Request struct {
	Method string
	Params json.RawMessage
}

// Fake is the app-server.
type Fake struct {
	// Client is the bridge's side: a real codex.Client over the pipes.
	Client *codex.Client

	mu       sync.Mutex
	results  map[string][]any
	failWith map[string]string
	requests []Request
	nextID   int
	waiting  map[string]chan reply

	out    *io.PipeWriter
	writes sync.Mutex
}

type reply struct {
	result json.RawMessage
	err    error
}

// New starts a fake and the client connected to it.
func New() *Fake {
	toFake, fromClient := io.Pipe()
	toClient, fromFake := io.Pipe()
	f := &Fake{results: map[string][]any{}, failWith: map[string]string{}, waiting: map[string]chan reply{}, out: fromFake}
	f.Client = codex.Connect(toClient, fromClient, func() error {
		_ = fromFake.Close()
		_ = fromClient.Close()
		return nil
	})
	go f.read(toFake)
	return f
}

// Result queues a canned result for method, answered in order.
func (f *Fake) Result(method string, result any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.results[method] = append(f.results[method], result)
}

// Fail makes every call to method fail with message.
func (f *Fake) Fail(method, message string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failWith[method] = message
}

// Requests is every request received, in order.
func (f *Fake) Requests() []Request {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Request(nil), f.requests...)
}

// Find is the first request for method, decoded into a map, or nil.
func (f *Fake) Find(method string) map[string]any {
	for _, r := range f.Requests() {
		if r.Method == method {
			var m map[string]any
			_ = json.Unmarshal(r.Params, &m)
			if m == nil {
				m = map[string]any{}
			}
			return m
		}
	}
	return nil
}

// Emit pushes a notification. emittedAtMs is omitted when nil.
func (f *Fake) Emit(method string, params any, emittedAtMs *int64) {
	m := map[string]any{"method": method, "params": params}
	if emittedAtMs != nil {
		m["emittedAtMs"] = *emittedAtMs
	}
	f.send(m)
}

// EmitServerRequest sends a server request and waits for the bridge's reply:
// its result, or its error frame as an error.
func (f *Fake) EmitServerRequest(method string, params any) (json.RawMessage, error) {
	f.mu.Lock()
	f.nextID++
	id := strconv.Itoa(1000 + f.nextID)
	ch := make(chan reply, 1)
	f.waiting[id] = ch
	f.mu.Unlock()
	f.send(map[string]any{"id": json.RawMessage(id), "method": method, "params": params})
	r := <-ch
	return r.result, r.err
}

// Close ends the feed, as the app-server exiting would.
func (f *Fake) Close() { _ = f.out.Close() }

func (f *Fake) send(m map[string]any) {
	b, err := json.Marshal(m)
	if err != nil {
		panic(err)
	}
	f.writes.Lock()
	defer f.writes.Unlock()
	_, _ = f.out.Write(append(b, '\n'))
}

func (f *Fake) read(in io.Reader) {
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 1<<20), 1<<24)
	for scanner.Scan() {
		var m struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(scanner.Bytes(), &m) != nil {
			continue
		}
		switch {
		case m.Method != "" && m.ID != nil:
			f.answer(m.ID, m.Method, m.Params)
		case m.Method == "" && m.ID != nil:
			f.mu.Lock()
			ch := f.waiting[string(m.ID)]
			delete(f.waiting, string(m.ID))
			f.mu.Unlock()
			if ch == nil {
				continue
			}
			if m.Error != nil {
				ch <- reply{err: errors.New(m.Error.Message)}
			} else {
				ch <- reply{result: m.Result}
			}
		}
	}
}

func (f *Fake) answer(id json.RawMessage, method string, params json.RawMessage) {
	f.mu.Lock()
	f.requests = append(f.requests, Request{Method: method, Params: params})
	failure, fails := f.failWith[method]
	var result any
	if queue := f.results[method]; len(queue) > 0 {
		result = queue[0]
		f.results[method] = queue[1:]
	}
	f.mu.Unlock()
	if fails {
		f.send(map[string]any{"id": id, "error": map[string]any{"code": -32600, "message": failure}})
		return
	}
	f.send(map[string]any{"id": id, "result": result})
}
