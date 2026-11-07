package mcp

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"slices"
	"time"

	"github.com/danielbodart/dragoman/internal/protocol"
	"github.com/danielbodart/dragoman/internal/run"
)

// ToolsJSON is the tools/list answer: each tool's name, description, input
// schema and a permissive output schema. The output schema's presence is
// what makes a client surface structuredContent (verified against Claude
// Code); it constrains nothing.
//
//go:embed tools.json
var ToolsJSON json.RawMessage

// StatusLongPoll is how long one codex_status blocks waiting for an event
// before it returns "still running" for the caller to poll again. It returns
// the instant an event lands, so this is only the cap for a quiet stretch,
// and also the worst-case delay before a steer or cancel reaches a subagent
// parked here. Routine steps are not events, so a busy run is quiet here
// too; 90s trades a slower steer for a third of the empty turns, under
// Claude Code's ~120s tool-call ceiling.
const StatusLongPoll = 90 * time.Second

// Tools answers tools/call.
type Tools struct {
	Runs *run.Runs
	// LiveMode takes the live permission mode the hook recorded for a
	// tool-use id.
	LiveMode func(toolUseID string) string
	// ToolUseID reads the tool-use id from a call's _meta.
	ToolUseID func(meta map[string]any) string
	// Diagnostics builds the diagnostics report.
	Diagnostics func() any
	// LongPoll is codex_status's cap; StatusLongPoll unless a test sets it.
	LongPoll time.Duration
}

// Status is a codex_status payload: the run's status and the events drained
// this poll. Usage is not here; it would ride every poll for nothing, and
// diagnostics has it.
type Status struct {
	Handle string      `json:"handle"`
	Status run.Status  `json:"status"`
	Events []run.Event `json:"events"`
}

// Ack answers the action tools: the handle to poll, and a line for the human.
type Ack struct {
	Handle  string `json:"handle,omitempty"`
	Message string `json:"message"`
}

// Failure is a tool error: a call that could not be made at all.
type Failure struct {
	Error string `json:"error"`
}

// unknownHandle is codex_status's answer for a handle it does not have. Not
// an MCP tool error, as the TypeScript sent it: the call worked, and this is
// its answer.
type unknownHandle struct {
	Error string `json:"error"`
}

// Call runs one tool.
func (t *Tools) Call(ctx context.Context, name string, raw json.RawMessage, meta map[string]any) (any, bool) {
	args, err := parseArgs(name, raw)
	if err != nil {
		return Failure{Error: err.Error()}, true
	}
	mode := func() string { return t.LiveMode(t.ToolUseID(meta)) }
	var result any
	switch name {
	case "codex_run":
		result, err = t.run(ctx, args, mode())
	case "codex_status":
		result = t.status(args)
	case "codex_steer":
		result, err = t.steer(ctx, args)
	case "codex_cancel":
		result, err = t.cancel(ctx, args)
	case "codex_continue":
		result, err = t.continueRun(ctx, args, mode())
	case "codex_review":
		result, err = t.review(ctx, args, mode())
	case "diagnostics":
		result = t.Diagnostics()
	default:
		return Failure{Error: "unknown tool: " + name}, true
	}
	if err != nil {
		return Failure{Error: err.Error()}, true
	}
	return result, false
}

// arguments are a tool's own arguments. They are Dragoman's, so they are
// read strictly: each named field must be a string, or the call fails
// naming it. Missing is the empty string, which each tool reports in its
// own words.
type arguments map[string]string

// toolFields are the fields each tool takes.
var toolFields = map[string][]string{
	"codex_run":      {"prompt", "cwd"},
	"codex_status":   {"handle"},
	"codex_steer":    {"handle", "text"},
	"codex_cancel":   {"handle"},
	"codex_continue": {"handle", "prompt"},
	"codex_review":   {"cwd", "against", "instructions"},
	"diagnostics":    {},
}

func parseArgs(tool string, raw json.RawMessage) (arguments, error) {
	args := arguments{}
	if len(raw) == 0 || string(raw) == "null" {
		return args, nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, fmt.Errorf("%s: arguments must be an object", tool)
	}
	for name, value := range fields {
		if !slices.Contains(toolFields[tool], name) {
			continue // a field this tool doesn't take; ignored, as MCP clients add their own
		}
		if string(value) == "null" {
			continue
		}
		var s string
		if err := json.Unmarshal(value, &s); err != nil {
			return nil, fmt.Errorf("%s: `%s` must be a string, got %s", tool, name, jsonKind(value))
		}
		args[name] = s
	}
	return args, nil
}

func jsonKind(raw json.RawMessage) string {
	switch raw[0] {
	case '{':
		return "an object"
	case '[':
		return "an array"
	case 't', 'f':
		return "a boolean"
	}
	return "a number"
}

func (t *Tools) run(ctx context.Context, args arguments, posture string) (any, error) {
	prompt, cwd := args["prompt"], args["cwd"]
	if prompt == "" || cwd == "" {
		return Ack{Message: "codex_run needs both `prompt` and `cwd`."}, nil
	}
	handle, err := t.Runs.Start(ctx, prompt, cwd, posture)
	if err != nil {
		return nil, err
	}
	return Ack{Handle: handle, Message: fmt.Sprintf("Started Codex task. Poll codex_status with handle %q.", handle)}, nil
}

func (t *Tools) steer(ctx context.Context, args arguments) (any, error) {
	handle, text := args["handle"], args["text"]
	if handle == "" || text == "" {
		return Ack{Message: "codex_steer needs both `handle` and `text`."}, nil
	}
	msg, err := t.Runs.Steer(ctx, handle, text)
	return Ack{Handle: handle, Message: msg}, err
}

func (t *Tools) cancel(ctx context.Context, args arguments) (any, error) {
	handle := args["handle"]
	if handle == "" {
		return Ack{Message: "codex_cancel needs a `handle`."}, nil
	}
	msg, err := t.Runs.Cancel(ctx, handle)
	return Ack{Handle: handle, Message: msg}, err
}

func (t *Tools) continueRun(ctx context.Context, args arguments, posture string) (any, error) {
	handle, prompt := args["handle"], args["prompt"]
	if handle == "" || prompt == "" {
		return Ack{Message: "codex_continue needs both `handle` and `prompt`."}, nil
	}
	msg, err := t.Runs.ContinueRun(ctx, handle, prompt, posture)
	return Ack{Handle: handle, Message: msg}, err
}

// review: a custom focus wins; else a diff against a named base; else the
// uncommitted changes.
func (t *Tools) review(ctx context.Context, args arguments, posture string) (any, error) {
	cwd := args["cwd"]
	if cwd == "" {
		return Ack{Message: "codex_review needs a `cwd`."}, nil
	}
	var target protocol.ReviewTarget
	switch {
	case args["instructions"] != "":
		target.Custom = &protocol.CustomReviewTarget{Instructions: args["instructions"]}
	case args["against"] != "":
		target.BaseBranch = &protocol.BaseBranchReviewTarget{Branch: args["against"]}
	default:
		target.UncommittedChanges = &protocol.UncommittedChangesReviewTarget{}
	}
	handle, err := t.Runs.Review(ctx, cwd, target, posture)
	if err != nil {
		return nil, err
	}
	return Ack{Handle: handle, Message: fmt.Sprintf("Started Codex review. Poll codex_status with handle %q.", handle)}, nil
}

// status long-polls unless something is already waiting: it returns the
// moment the run has an event or settles, else after the cap with nothing,
// for the caller to poll again. It drains the one timeline, every event
// delivered exactly once, in order.
func (t *Tools) status(args arguments) any {
	handle := args["handle"]
	if _, ok := t.Runs.Status(handle); !ok {
		return unknownHandle{Error: fmt.Sprintf("No Codex task with handle %q.", handle)}
	}
	wait := t.LongPoll
	if wait == 0 {
		wait = StatusLongPoll
	}
	t.Runs.WaitForEvents(handle, wait)
	rec, ok := t.Runs.Status(handle)
	if !ok {
		return unknownHandle{Error: fmt.Sprintf("No Codex task with handle %q.", handle)}
	}
	return Status{Handle: handle, Status: rec.Status, Events: t.Runs.Drain(handle)}
}
