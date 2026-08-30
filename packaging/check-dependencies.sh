#!/bin/bash
# SessionStart hook: warn early if `bun` is missing.
#
# Dragoman ships as a bundled JS run by bun (not a self-contained binary), so
# bun must be on PATH for the MCP server to start. Surfacing this here turns a
# silent "MCP server failed to connect" into an actionable message.

# Consume stdin (SessionStart sends JSON input).
cat > /dev/null

command -v bun >/dev/null 2>&1 && exit 0

# Hand-rolled JSON (no jq dependency, and jq may itself be absent).
cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"dragoman plugin: `bun` is not installed, so the Dragoman MCP server cannot start. Install it with: curl -fsSL https://bun.sh/install | bash"}}
EOF
exit 2
