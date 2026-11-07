// Package codex is the Codex app-server edge: the JSON-RPC-like duplex over a
// pair of pipes that Dragoman drives and the tests fake.
//
// Wire notes (see generated/codex-protocol/README.md): the app-server speaks
// NDJSON, one JSON object per line, in a JSON-RPC-like dialect with no
// `jsonrpc` field. Messages are a request {id, method, params}, a response
// {id, result} or {id, error}, and a notification {method, params} with an
// optional top-level emittedAtMs.
//
// Three channels, matching the three things the protocol does:
//   - Request: client to server RPC (thread/start, turn/start, ...).
//   - Notifications: the server to client push feed, read by one reader (the
//     pump).
//   - OnServerRequest: the server to client requests (approvals). One
//     handler; its return value is the reply. The read loop keeps reading
//     while a handler is pending, so a slow approval never stalls
//     notifications: the hang the official plugin caused by answering
//     synchronously with -32601.
package codex

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"sync"

	"github.com/danielbodart/dragoman/internal/protocol"
	"github.com/danielbodart/dragoman/internal/version"
)

// Notification is a server to client notification, its params left raw for
// whoever routes it by method.
type Notification struct {
	Method      string
	Params      json.RawMessage
	EmittedAtMs *int64
}

// ServerRequest is a server to client request, the approval path this whole
// bridge exists to answer.
type ServerRequest struct {
	ID     json.RawMessage
	Method string
	Params json.RawMessage
}

// Handler answers a server request. Its result is the reply; an error becomes
// a well-formed JSON-RPC error frame, never a guessed result.
type Handler func(ServerRequest) (any, error)

// Conn is the Codex app-server as Dragoman drives it.
type Conn interface {
	// Request sends a client to server request and waits for its result.
	Request(ctx context.Context, method string, params any) (json.RawMessage, error)
	// Notifications is the push feed, closed when the connection ends.
	Notifications() <-chan Notification
	// OnServerRequest registers the one handler for server requests.
	OnServerRequest(Handler)
	// Close ends the connection and fails anything in flight.
	Close() error
}

// ErrExited is how a request in flight fails when the app-server goes away.
var ErrExited = errors.New("codex app-server exited")

// ErrClosed is how a request in flight fails when the connection is closed.
var ErrClosed = errors.New("connection closed")

type wire struct {
	ID          json.RawMessage `json:"id,omitempty"`
	Method      string          `json:"method,omitempty"`
	Params      json.RawMessage `json:"params,omitempty"`
	Result      json.RawMessage `json:"result,omitempty"`
	Error       *wireError      `json:"error,omitempty"`
	EmittedAtMs *int64          `json:"emittedAtMs,omitempty"`
}

type wireError struct {
	Code    int64           `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

type response struct {
	result json.RawMessage
	err    error
}

// Client is a Conn over any reader and writer: a subprocess's stdout and
// stdin in production, an io.Pipe in the tests.
type Client struct {
	out    io.Writer
	writes sync.Mutex
	closer func() error

	mu      sync.Mutex
	nextID  int64
	pending map[string]chan response
	ended   error
	handler Handler

	feed *queue
	done chan struct{}
}

// Connect starts the one read loop over in and returns a Client writing to
// out. closer, when set, is run by Close.
func Connect(in io.Reader, out io.Writer, closer func() error) *Client {
	c := &Client{out: out, closer: closer, pending: map[string]chan response{}, feed: newQueue(), done: make(chan struct{})}
	go c.read(in)
	return c
}

// Request sends method with params (omitted when nil) and waits for the reply.
func (c *Client) Request(ctx context.Context, method string, params any) (json.RawMessage, error) {
	var raw json.RawMessage
	if params != nil {
		b, err := json.Marshal(params)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", method, err)
		}
		raw = b
	}
	c.mu.Lock()
	if c.ended != nil {
		err := c.ended
		c.mu.Unlock()
		return nil, err
	}
	c.nextID++
	id := strconv.FormatInt(c.nextID, 10)
	reply := make(chan response, 1)
	c.pending[id] = reply
	c.mu.Unlock()

	c.write(wire{ID: json.RawMessage(id), Method: method, Params: raw})
	select {
	case r := <-reply:
		return r.result, r.err
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, ctx.Err()
	}
}

// Notify sends a notification.
func (c *Client) Notify(method string) {
	c.write(wire{Method: method})
}

// Notifications is the feed, closed once the connection ends.
func (c *Client) Notifications() <-chan Notification { return c.feed.out }

// OnServerRequest registers the handler for server requests.
func (c *Client) OnServerRequest(h Handler) {
	c.mu.Lock()
	c.handler = h
	c.mu.Unlock()
}

// Done is closed once the read loop has ended.
func (c *Client) Done() <-chan struct{} { return c.done }

// Close fails everything in flight, ends the feed and runs the closer.
func (c *Client) Close() error {
	c.end(ErrClosed)
	if c.closer != nil {
		return c.closer()
	}
	return nil
}

// end fails every pending request with err and ends the feed. The first
// ending wins.
func (c *Client) end(err error) {
	c.mu.Lock()
	if c.ended != nil {
		c.mu.Unlock()
		return
	}
	c.ended = err
	pending := c.pending
	c.pending = map[string]chan response{}
	c.mu.Unlock()
	for _, reply := range pending {
		reply <- response{err: err}
	}
	c.feed.close()
}

// read is the single inbound loop: frame, classify, dispatch. However it
// ends, a clean EOF included, everything in flight is failed, or a pending
// request would hang forever.
func (c *Client) read(in io.Reader) {
	defer close(c.done)
	err := lines(in, func(line []byte) {
		var m wire
		if json.Unmarshal(line, &m) != nil {
			return // a garbled line is skipped rather than killing the loop
		}
		c.route(m)
	})
	if err == nil || errors.Is(err, io.ErrClosedPipe) || errors.Is(err, os.ErrClosed) {
		c.end(ErrExited)
	} else {
		c.end(fmt.Errorf("%w: %v", ErrExited, err))
	}
}

// lines splits a byte stream delivered in arbitrary chunks into trimmed,
// non-empty NDJSON lines, holding a partial line back until its newline
// arrives. A final fragment with no newline is not a line, and is dropped.
// It returns nil at EOF.
func lines(in io.Reader, yield func([]byte)) error {
	r := bufio.NewReaderSize(in, 1<<16)
	for {
		line, err := r.ReadBytes('\n')
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		if line = bytes.TrimSpace(line); len(line) > 0 {
			yield(line)
		}
	}
}

func (c *Client) route(m wire) {
	switch {
	case m.ID != nil && (m.Result != nil || m.Error != nil):
		id := canonicalID(m.ID)
		c.mu.Lock()
		reply, ok := c.pending[id]
		delete(c.pending, id)
		c.mu.Unlock()
		if !ok {
			return
		}
		if m.Error != nil {
			reply <- response{err: fmt.Errorf("%d: %s", m.Error.Code, m.Error.Message)}
		} else {
			reply <- response{result: m.Result}
		}
	case m.ID != nil && m.Method != "":
		// Answered without blocking the loop: the reply is written when the
		// handler returns, while this loop keeps reading.
		c.mu.Lock()
		h := c.handler
		c.mu.Unlock()
		request := ServerRequest{ID: m.ID, Method: m.Method, Params: m.Params}
		go func() {
			if h == nil {
				c.reply(request.ID, nil, errors.New("no server-request handler registered"))
				return
			}
			result, err := h(request)
			c.reply(request.ID, result, err)
		}()
	case m.Method != "":
		c.feed.push(Notification{Method: m.Method, Params: m.Params, EmittedAtMs: m.EmittedAtMs})
	}
}

func (c *Client) reply(id json.RawMessage, result any, err error) {
	if err != nil {
		c.write(wire{ID: id, Error: &wireError{Code: -32603, Message: err.Error()}})
		return
	}
	b, merr := json.Marshal(result)
	if merr != nil {
		c.write(wire{ID: id, Error: &wireError{Code: -32603, Message: merr.Error()}})
		return
	}
	c.write(wire{ID: id, Result: b})
}

// write sends one frame. A write can lose its race with shutdown (an approval
// answered after Close), which is expected here, so its error is dropped.
func (c *Client) write(m wire) {
	b, err := json.Marshal(m)
	if err != nil {
		return
	}
	b = append(b, '\n')
	c.writes.Lock()
	defer c.writes.Unlock()
	_, _ = c.out.Write(b)
}

// canonicalID makes a numeric id and its string form match as map keys.
func canonicalID(raw json.RawMessage) string {
	var n json.Number
	if json.Unmarshal(raw, &n) == nil {
		return n.String()
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	return string(raw)
}

// Start spawns command (a `codex app-server`) with env merged over this
// process's environment, and completes the handshake, so the Client it
// returns is initialized. Codex's stderr passes through to ours, never onto
// the protocol.
func Start(ctx context.Context, command []string, env map[string]string) (*Client, error) {
	if len(command) == 0 {
		return nil, errors.New("no codex command")
	}
	cmd := exec.Command(command[0], command[1:]...)
	cmd.Stderr = os.Stderr
	cmd.Env = os.Environ()
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start %s: %w", command[0], err)
	}
	var once sync.Once
	stop := func() error {
		once.Do(func() {
			_ = stdin.Close()
			_ = cmd.Process.Kill()
		})
		return nil
	}
	c := Connect(stdout, stdin, stop)
	go func() {
		<-c.Done()
		_ = cmd.Wait()
	}()

	title := "Dragoman"
	yes, no := true, false
	params := protocol.InitializeParams{
		ClientInfo:   protocol.ClientInfo{Name: "dragoman", Title: &title, Version: version.Version},
		Capabilities: &protocol.InitializeCapabilities{ExperimentalApi: &yes, RequestAttestation: &no},
	}
	if _, err := c.Request(ctx, "initialize", params); err != nil {
		_ = c.Close()
		return nil, err
	}
	c.Notify("initialized")
	return c, nil
}

// queue bridges the read loop to the one feed reader without ever blocking
// the loop: it buffers when the reader is behind.
type queue struct {
	mu     sync.Mutex
	items  []Notification
	wake   chan struct{}
	closed bool
	out    chan Notification
}

func newQueue() *queue {
	q := &queue{wake: make(chan struct{}, 1), out: make(chan Notification)}
	go q.pump()
	return q
}

func (q *queue) push(n Notification) {
	q.mu.Lock()
	if !q.closed {
		q.items = append(q.items, n)
	}
	q.mu.Unlock()
	q.signal()
}

func (q *queue) close() {
	q.mu.Lock()
	q.closed = true
	q.mu.Unlock()
	q.signal()
}

func (q *queue) signal() {
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

// pump hands the buffered notifications to out in order, then closes out
// once the queue is closed and drained.
func (q *queue) pump() {
	for {
		q.mu.Lock()
		if len(q.items) > 0 {
			n := q.items[0]
			q.items = q.items[1:]
			q.mu.Unlock()
			q.out <- n
			continue
		}
		closed := q.closed
		q.mu.Unlock()
		if closed {
			close(q.out)
			return
		}
		<-q.wake
	}
}
