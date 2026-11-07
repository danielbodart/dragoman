package posture

// Claude's live permission mode, handed over by the PreToolUse hook.
//
// The server can read only the static permissions.defaultMode, so a
// mid-session switch (to plan, acceptEdits, ...) never reaches it. A
// PreToolUse hook does see the live mode (.permission_mode on stdin), so the
// hook writes it to a file just before each codex_run, codex_continue and
// codex_review, and the server takes it here.
//
// Why a file, not the tool input: the hook used to add `posture` through
// updatedInput, but Claude Code's auto-mode classifier refuses to judge input
// a hook changed, so every call in auto mode was rejected once and resent.
//
// The file is named by the tool-use id of that one call: the hook gets it as
// .tool_use_id, and Claude Code sends the same id on the MCP request as
// _meta["claudecode/toolUseId"]. Each file is read once and deleted, so a
// mode only ever applies to the call it was recorded for.

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/danielbodart/gokit/environ"
)

// safeID is a tool-use id safe as a file name (Claude Code's are toolu_...).
var safeID = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// LiveModeDir is where the hook writes: $XDG_RUNTIME_DIR, else $TMPDIR, else
// the system temp dir, then dragoman/live-mode.
func LiveModeDir(env environ.Env) string {
	root := env["XDG_RUNTIME_DIR"]
	if root == "" {
		root = env["TMPDIR"]
	}
	if root == "" {
		root = os.TempDir()
	}
	return filepath.Join(root, "dragoman", "live-mode")
}

// LiveModePath is the file for one tool call, or "" for a missing or unsafe
// id.
func LiveModePath(toolUseID string, env environ.Env) string {
	if !safeID.MatchString(toolUseID) {
		return ""
	}
	return filepath.Join(LiveModeDir(env), toolUseID)
}

// TakeLiveMode reads and deletes the mode the hook recorded for this call;
// "" when there is none.
func TakeLiveMode(toolUseID string, env environ.Env) string {
	path := LiveModePath(toolUseID, env)
	if path == "" {
		return ""
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	_ = os.Remove(path)
	return strings.TrimSpace(string(data))
}

// RecordLiveMode writes mode for toolUseID, write-then-rename so the server
// never reads half a file. A missing mode or an unsafe id records nothing.
func RecordLiveMode(toolUseID, mode string, env environ.Env) error {
	path := LiveModePath(toolUseID, env)
	if path == "" || mode == "" {
		return nil
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+toolUseID+".*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.WriteString(mode + "\n"); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// ToolUseIDOf is the tool-use id Claude Code attaches to a tools/call's
// _meta, if any.
func ToolUseIDOf(meta map[string]any) string {
	id, _ := meta["claudecode/toolUseId"].(string)
	return id
}
