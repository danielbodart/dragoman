// Package mcp is the Claude Code edge: a stdio MCP server exposing
// Dragoman's tools, and the elicitation channel approvals ride.
//
// It is hand-written rather than built on the Go MCP SDK (PLAN.md step 0):
// Dragoman sends elicitation/create from its own goroutine, whenever Codex
// asks for an approval, not from inside a tool call, and the SDK (v1.8.0)
// refuses that to any client that requests protocol 2026-07-28 or later,
// even after negotiating an older one. Dragoman uses four methods
// (initialize, tools/list, tools/call, elicitation/create), so the server is
// small.
//
// MCP's formats are not Dragoman's, so it is lenient: an unknown field is
// ignored, an unknown notification is dropped, a protocol version it does not
// know is answered with the newest it implements rather than refused.
package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"strconv"
	"sync"

	"github.com/danielbodart/dragoman/internal/version"
	"github.com/danielbodart/gokit/logx"
)

// protocolVersions are the MCP versions this server speaks, newest first.
// Each lets the server send elicitation/create on its own initiative, which
// 2026-07-28 does not. A client asking for one of these gets it back; any
// other gets the newest, and the client decides whether it can speak that.
var protocolVersions = []string{"2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"}

// CallTool runs one tools/call: name, its arguments and _meta, returning the
// structured result and whether it is an error.
type CallTool func(ctx context.Context, name string, args json.RawMessage, meta map[string]any) (any, bool)

// Server is one MCP session over a reader and a writer.
type Server struct {
	Tools json.RawMessage
	Call  CallTool
	Log   logx.Logger

	out    io.Writer
	writes sync.Mutex

	mu           sync.Mutex
	nextID       int64
	pending      map[string]chan reply
	ended        bool
	elicitations bool
	initialized  bool
}

type reply struct {
	result json.RawMessage
	err    error
}

type message struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int64           `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

// ErrClosed is how an elicitation in flight fails when the client goes away.
var ErrClosed = errors.New("MCP client disconnected")

// NewServer makes a server for tools, answering tools/call with call.
func NewServer(tools json.RawMessage, call CallTool, log logx.Logger) *Server {
	if log == nil {
		log = logx.Discard
	}
	return &Server{Tools: tools, Call: call, Log: log, pending: map[string]chan reply{}}
}

// Serve reads requests from in and writes to out until in ends. Each request
// is handled on its own goroutine, so a long-polling codex_status never holds
// up another call, or the answer to an elicitation.
func (s *Server) Serve(ctx context.Context, in io.Reader, out io.Writer) error {
	s.out = out
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var wg sync.WaitGroup
	r := bufio.NewReaderSize(in, 1<<16)
	var err error
	for {
		line, rerr := r.ReadBytes('\n')
		if line = bytes.TrimSpace(line); len(line) > 0 {
			var m message
			if json.Unmarshal(line, &m) != nil {
				s.send(message{ID: json.RawMessage("null"), Error: &rpcError{Code: -32700, Message: "Parse error"}})
			} else {
				s.dispatch(ctx, &wg, m)
			}
		}
		if rerr != nil {
			if !errors.Is(rerr, io.EOF) {
				err = rerr
			}
			break
		}
	}
	// Not waiting for calls in flight: a codex_status may be parked for
	// another 90s, and the process should exit when Claude Code closes the
	// pipe.
	s.end()
	return err
}

func (s *Server) dispatch(ctx context.Context, wg *sync.WaitGroup, m message) {
	switch {
	case m.Method != "" && m.ID != nil:
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, rerr := s.request(ctx, m.Method, m.Params)
			if rerr != nil {
				s.send(message{ID: m.ID, Error: rerr})
				return
			}
			b, err := json.Marshal(result)
			if err != nil {
				s.send(message{ID: m.ID, Error: &rpcError{Code: -32603, Message: err.Error()}})
				return
			}
			s.send(message{ID: m.ID, Result: b})
		}()
	case m.Method != "":
		if m.Method == "notifications/initialized" {
			s.mu.Lock()
			s.initialized = true
			s.mu.Unlock()
		}
		// Every other notification (cancelled, progress, roots) is dropped.
	case m.ID != nil:
		s.mu.Lock()
		ch, ok := s.pending[canonicalID(m.ID)]
		delete(s.pending, canonicalID(m.ID))
		s.mu.Unlock()
		if !ok {
			return
		}
		if m.Error != nil {
			ch <- reply{err: fmt.Errorf("%d: %s", m.Error.Code, m.Error.Message)}
		} else {
			ch <- reply{result: m.Result}
		}
	}
}

func (s *Server) request(ctx context.Context, method string, params json.RawMessage) (any, *rpcError) {
	switch method {
	case "initialize":
		return s.initialize(params), nil
	case "ping":
		return struct{}{}, nil
	case "tools/list":
		return map[string]json.RawMessage{"tools": s.Tools}, nil
	case "tools/call":
		var p struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
			Meta      map[string]any  `json:"_meta"`
		}
		if err := json.Unmarshal(params, &p); err != nil || p.Name == "" {
			return nil, &rpcError{Code: -32602, Message: "tools/call needs a tool `name`"}
		}
		structured, isError := s.Call(ctx, p.Name, p.Arguments, p.Meta)
		return toolResult(structured, isError), nil
	}
	return nil, &rpcError{Code: -32601, Message: "Method not found: " + method}
}

// initialize answers the handshake: the client's version if this server
// speaks it, else the newest it does. Only the client's elicitation
// capability is read; the rest of what it sends is its business.
func (s *Server) initialize(params json.RawMessage) any {
	var p struct {
		ProtocolVersion string `json:"protocolVersion"`
		Capabilities    struct {
			Elicitation json.RawMessage `json:"elicitation"`
		} `json:"capabilities"`
	}
	_ = json.Unmarshal(params, &p)
	negotiated := protocolVersions[0]
	if slices.Contains(protocolVersions, p.ProtocolVersion) {
		negotiated = p.ProtocolVersion
	}
	s.mu.Lock()
	// Form elicitation, as the TypeScript SDK reads it: an elicitation
	// capability that names form, or names neither form nor url.
	var modes map[string]json.RawMessage
	if json.Unmarshal(p.Capabilities.Elicitation, &modes) == nil && modes != nil {
		_, form := modes["form"]
		_, url := modes["url"]
		s.elicitations = form || !url
	}
	s.mu.Unlock()
	return map[string]any{
		"protocolVersion": negotiated,
		"capabilities":    map[string]any{"tools": map[string]any{}},
		"serverInfo":      map[string]any{"name": "dragoman", "version": version.Version},
	}
}

// toolResult wraps a structured payload as an MCP tool result. Dragoman is
// all structured: the payload rides structuredContent, which Claude Code
// shows the model, and content carries the same object serialized, so the
// frame stays valid for any other client. There is no second, hand-written
// rendering.
func toolResult(structured any, isError bool) map[string]any {
	text, _ := json.Marshal(structured)
	r := map[string]any{
		"content":           []map[string]any{{"type": "text", "text": string(text)}},
		"structuredContent": structured,
	}
	if isError {
		r["isError"] = true
	}
	return r
}

// Elicit sends elicitation/create and waits for the human's answer, from any
// goroutine, at any time after initialize.
func (s *Server) Elicit(ctx context.Context, params any) (json.RawMessage, error) {
	s.mu.Lock()
	if s.ended {
		s.mu.Unlock()
		return nil, ErrClosed
	}
	if !s.elicitations {
		s.mu.Unlock()
		return nil, errors.New("the MCP client does not support elicitation")
	}
	s.nextID++
	id := strconv.FormatInt(s.nextID, 10)
	ch := make(chan reply, 1)
	s.pending[id] = ch
	s.mu.Unlock()

	b, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	s.send(message{ID: json.RawMessage(id), Method: "elicitation/create", Params: b})
	select {
	case r := <-ch:
		return r.result, r.err
	case <-ctx.Done():
		s.mu.Lock()
		delete(s.pending, id)
		s.mu.Unlock()
		return nil, ctx.Err()
	}
}

func (s *Server) end() {
	s.mu.Lock()
	s.ended = true
	pending := s.pending
	s.pending = map[string]chan reply{}
	s.mu.Unlock()
	for _, ch := range pending {
		ch <- reply{err: ErrClosed}
	}
}

func (s *Server) send(m message) {
	m.JSONRPC = "2.0"
	b, err := json.Marshal(m)
	if err != nil {
		return
	}
	b = append(b, '\n')
	s.writes.Lock()
	defer s.writes.Unlock()
	if s.out != nil {
		_, _ = s.out.Write(b)
	}
}

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
