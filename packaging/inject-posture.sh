#!/usr/bin/env bash
# PreToolUse hook for codex_run / codex_continue / codex_review — record Claude's LIVE
# permission mode for the MCP server.
#
# The MCP server can't see the current interactive permission mode: it reads only the
# static `permissions.defaultMode` from settings.json, so a mid-session switch (e.g. to
# `plan` or `acceptEdits`) never reaches it. But a PreToolUse hook DOES get the live
# mode on stdin as `.permission_mode`. We write it to a file named after this call's
# `.tool_use_id`, which Claude Code also sends on the MCP request; the server reads
# and deletes it (src/live-mode.ts computes the same path — keep the two in step).
#
# We deliberately do NOT touch the tool input. Returning `updatedInput` made Claude
# Code's auto-mode classifier refuse the call (it won't judge input a hook changed),
# so every Codex call in auto mode had to be resent. This hook prints nothing.

INPUT=$(cat)

MODE=$(printf '%s' "$INPUT" | jq -r '.permission_mode // empty')
CALL=$(printf '%s' "$INPUT" | jq -r '.tool_use_id // empty')

# Nothing to record, or a tool-use id we won't use as a file name.
[ -n "$MODE" ] && [ -n "$CALL" ] || exit 0
case "$CALL" in *[!A-Za-z0-9_-]*) exit 0 ;; esac

DIR="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/dragoman/live-mode"
mkdir -p -m 700 "$DIR" 2>/dev/null || exit 0

# Write-then-rename so the server never reads a half-written file.
TMP="$DIR/.$CALL.$$"
printf '%s\n' "$MODE" > "$TMP" && mv -f "$TMP" "$DIR/$CALL" || rm -f "$TMP"
exit 0
