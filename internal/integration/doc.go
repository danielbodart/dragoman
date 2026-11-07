// Package integration holds the live tests that talk to a real `codex
// app-server` through Dragoman's own internals, proving Codex honours what
// the mirror emits. They build only with -tags integration.
//
// Two kinds:
//   - model-free: command/exec runs one command in the sandbox with no
//     thread, turn or model call. Free and deterministic; CI runs these.
//   - model turns: the full run and pump stack against real Codex, spending
//     a turn. They also need DRAGOMAN_MODEL_TESTS=1, so CI never runs them.
//
// Every test is ratcheted (verifyOnce): once it passes, a marker skips it
// until its file changes. Delete .state/ to run them all again. They skip
// when the codex command is not on PATH. DRAGOMAN_CODEX_COMMAND picks the
// command, as it does for the server.
package integration
