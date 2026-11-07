package mcp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// The tools' arguments are Dragoman's own, so they are strict: a field of
// the wrong type fails the call naming it. A missing one gets the tool's
// own message, as before.
func TestToolArgumentsAreStrict(t *testing.T) {
	tools := &Tools{LiveMode: func(string) string { return "" }, ToolUseID: func(map[string]any) string { return "" }}
	got, isError := tools.Call(context.Background(), "codex_run", json.RawMessage(`{"prompt":42,"cwd":"/x"}`), nil)
	if !isError || !strings.Contains(got.(Failure).Error, "`prompt` must be a string, got a number") {
		t.Fatalf("got %v, %v", got, isError)
	}
	got, isError = tools.Call(context.Background(), "codex_run", json.RawMessage(`{"cwd":"/x"}`), nil)
	if isError || got.(Ack).Message != "codex_run needs both `prompt` and `cwd`." {
		t.Fatalf("got %v, %v", got, isError)
	}
	got, isError = tools.Call(context.Background(), "codex_steer", json.RawMessage(`[1]`), nil)
	if !isError || !strings.Contains(got.(Failure).Error, "arguments must be an object") {
		t.Fatalf("got %v, %v", got, isError)
	}
	got, isError = tools.Call(context.Background(), "nope", nil, nil)
	if !isError || got.(Failure).Error != "unknown tool: nope" {
		t.Fatalf("got %v, %v", got, isError)
	}
}
