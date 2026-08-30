#!/bin/bash
# PreToolUse hook for codex_run — inject Claude's LIVE permission mode as `posture`.
#
# The MCP server can't see the current interactive permission mode: it reads only the
# static `permissions.defaultMode` from settings.json, so a mid-session switch (e.g. to
# `plan` or `acceptEdits`) never reaches it. But a PreToolUse hook DOES get the live
# mode on stdin as `.permission_mode`. So we read it here and merge it into the
# codex_run tool input as `posture`, which Dragoman already mirrors onto Codex.
#
# If the model set `posture` explicitly (a deliberate override, e.g. "run Codex
# read-only"), we leave it alone. If there's no mode, we do nothing and Dragoman falls
# back to its own resolution.

INPUT=$(cat)

MODE=$(printf '%s' "$INPUT" | jq -r '.permission_mode // empty')
EXISTING=$(printf '%s' "$INPUT" | jq -r '.tool_input.posture // empty')

# Nothing to inject: explicit override present, or no mode reported.
if [ -n "$EXISTING" ] || [ -z "$MODE" ]; then
  exit 0
fi

# Add `posture` and echo back the WHOLE tool input: `updatedInput` REPLACES the input
# (verified — it does not merge, despite the docs), so returning only `{posture}` would
# drop `prompt`/`cwd`.
printf '%s' "$INPUT" | jq -c --arg mode "$MODE" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    updatedInput: (.tool_input + { posture: $mode })
  }
}'
