// Package hook is Dragoman's Claude Code hooks, run as `dragoman hook
// <name>`, so they need nothing installed: no bash features, no jq.
//
// A hook must never get in the way of the tool call it rides: whatever
// happens, it exits 0, and prints only what Claude Code should act on.
// Claude Code owns the hook input, so it is read leniently: unknown fields
// are ignored, and a field of the wrong type is as good as missing.
package hook

import (
	"encoding/json"
	"fmt"
	"io"
	"os/exec"

	"github.com/danielbodart/dragoman/internal/posture"
	"github.com/danielbodart/gokit/environ"
)

// Posture is the PreToolUse hook for codex_run, codex_continue and
// codex_review: it records Claude's live permission mode for this call's
// tool-use id, where the server takes it from. It prints nothing and never
// touches the tool input: returning updatedInput made Claude Code's
// auto-mode classifier refuse the call.
func Posture(stdin io.Reader, env environ.Env) {
	var input map[string]any
	if json.NewDecoder(stdin).Decode(&input) != nil {
		return
	}
	mode, _ := input["permission_mode"].(string)
	call, _ := input["tool_use_id"].(string)
	_ = posture.RecordLiveMode(call, mode, env)
}

// Check is the SessionStart hook: with no codex on PATH every codex_run
// would fail, so it tells Claude why up front, as additional context.
func Check(stdin io.Reader, stdout io.Writer, lookPath func(string) (string, error)) {
	_, _ = io.Copy(io.Discard, stdin)
	if _, err := lookPath("codex"); err == nil {
		return
	}
	out, _ := json.Marshal(map[string]any{"hookSpecificOutput": map[string]any{
		"hookEventName":     "SessionStart",
		"additionalContext": "dragoman plugin: `codex` is not on PATH, so Dragoman cannot start Codex. Install it with: npm i -g @openai/codex (or see https://github.com/openai/codex).",
	}})
	fmt.Fprintln(stdout, string(out))
}

// LookPath is exec.LookPath, for Check.
var LookPath = exec.LookPath
