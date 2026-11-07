# Dragoman in Go — plan

> **Status:** proposed. The port follows the path Treesinger, Portical and
> Tidewaiter took on 23 October 2026: first a faithful port next to the
> TypeScript, its tests ported one to one; then the TypeScript removed, with
> the port made strict where JavaScript happened to be lenient. After that it
> gets the release machinery those three have.

## Why

- **No runtime to install.** Today the plugin is a bundled JS file that runs
  under `bun`. A user without bun on PATH gets a silent "MCP server failed to
  connect", which `check-dependencies.sh` exists only to explain. nix-config
  installs `pkgs.bun` just for this (`features/dragoman/home.nix`). A static Go
  binary needs nothing besides `codex`.
- **One server per Claude session.** Every open session starts its own bridge,
  so memory and startup time add up. Treesinger's port measured 7 MB resident
  against 46 MB, and 1.7 ms to serve against 11.8 ms.
- **No `jq` in the hooks.** The PreToolUse hook needs `jq`. That is missing on
  macOS before 15 and on a bare Linux install, and without it the live mode is
  lost silently. As a subcommand of the binary, the hook needs nothing.
- **The same shape as the other repos:** mise tasks, `./run`, `MAJOR`,
  `release-due`, the Weekly update, cosign.

## Toolchain

As in the other repos, mise installs everything, both locally and in CI:
`mise.toml`'s `[tools]` changes `bun = "1.3"` to `go = "1.27.3"` and
`cosign = "3.0.6"`, and every job uses `jdx/mise-action@v5`, never `setup-go`.
The Weekly update moves both to the latest patch of their minor. Dragoman has
no flake of its own and still gets none (nix-config fetches the release zip),
so there is no second Go to keep in step with mise's.

## Platforms

| Target | Binary | Tested in CI on |
|---|---|---|
| Linux x86_64 | `dragoman-linux-x86_64` | `ubuntu-latest` |
| Linux aarch64 | `dragoman-linux-aarch64` | built only (cross-compiled) |
| macOS on Apple silicon (M1 and later) | `dragoman-darwin-arm64` | `macos-latest` (arm64) |

**Not supported:** Windows (use WSL, which is Linux) and Intel Macs. The
README says so under Install and under Channels. On Windows the plugin does
nothing; see Packaging.

All binaries are built with `CGO_ENABLED=0`, so they are static and run on
NixOS unpatched. Go's linker ad-hoc signs darwin/arm64 binaries, even when
cross-compiling from Linux, which Apple silicon requires before it will run
them. No notarization is needed: Claude Code unpacks the plugin zip itself, so
the binary never gets Gatekeeper's quarantine attribute (step 0 confirms this).

## Packaging

The marketplace `archive` source is still a single url+sha256, so the one zip
carries all three binaries (about 8 MB each; about 10 MB zipped, against
116 MB for the old `bun --compile`):

```
.claude-plugin/plugin.json
.mcp.json            -> { "command": "${CLAUDE_PLUGIN_ROOT}/bin/dragoman", "args": ["serve"] }
hooks.json           -> PreToolUse: "${CLAUDE_PLUGIN_ROOT}/bin/dragoman hook posture"
bin/dragoman         POSIX sh launcher: picks bin/<os>-<arch>/dragoman from `uname -sm`, exec's it
bin/linux-x86_64/dragoman
bin/linux-aarch64/dragoman
bin/darwin-arm64/dragoman
skills/  agents/
```

- **Windows does nothing.** When the launcher sees Windows (`uname -s` is
  `MINGW*`, `MSYS*` or `CYGWIN*`, as Claude Code's Git Bash reports it, or
  there is no `uname` at all), it does nothing and exits 0: `hook` calls print
  nothing, so no tool call is blocked or slowed, and `serve` writes one stderr
  line ("Dragoman does not support Windows; use WSL") and exits, so Claude Code
  shows the bridge as not connected rather than broken. A Linux or macOS
  machine with an architecture we don't build for gets the same treatment,
  with a message naming the supported platforms instead of a bare "exec
  format error".
- `check-dependencies.sh` goes away; there is no runtime left to check for. If a
  SessionStart warning is still useful, it becomes `dragoman hook check` and
  checks that `codex` is on PATH.
- `inject-posture.sh` becomes `dragoman hook posture`: it reads the hook JSON
  from stdin and writes the live mode to the same directory `livemode` reads
  from. The path rule now lives in one place instead of two that had to be kept
  in step.
- nix-config keeps its build-time fetch of the zip unchanged, and drops
  `pkgs.bun` from `features/dragoman/home.nix`.

## Step 0 — spikes (prove what this plan assumes)

Each spike answers one question with a small throwaway program.

1. **Go MCP SDK** (`github.com/modelcontextprotocol/go-sdk`): can the server
   send `elicitation/create` at any time from its own goroutine, as
   `Server.elicitInput()` does today (`src/mcp.ts:5`)? Do tool results and the
   long-poll `codex_status` behave the same? If elicitation is missing or tied
   to a request, the fallback is a small hand-written JSON-RPC MCP server over
   stdio: dragoman uses only `initialize`, `tools/list`, `tools/call` and
   `elicitation/create`.
2. **Protocol bindings from the JSON schema:** generate Go for the types
   `src/` imports, `ThreadItem` included (a tagged union). Off-the-shelf schema
   generators handle `oneOf` badly, so expect a small generator of our own
   under `internal/protocol/gen` (see below).
3. **macOS end to end on `macos-latest`:** cross-compile darwin/arm64 on Linux,
   unpack the zip there, run the launcher, and complete an MCP `initialize`.
   Install `codex` (`npm i -g @openai/codex`) and check that `command/exec`
   runs without being logged in, which decides how much of the integration
   suite CI can run (see CI).
4. **gokit `logx` on darwin:** confirm it builds and runs. Dragoman needs none
   of the Linux-only packages (`dbusx`, `sockdiag`).

## Step 1 — port next to the TypeScript

Layout, one package per source file, with the same responsibilities:

| TypeScript | Go |
|---|---|
| `src/main.ts` | `main.go` (subcommands `serve`, `hook posture`, `version`) |
| `src/mcp.ts`, `src/elicitation.ts` | `internal/mcp` |
| `src/codex.ts` (app-server process, JSON-RPC framing) | `internal/codex` |
| `src/pump.ts`, `src/thread-run.ts`, `src/heartbeat.ts` | `internal/run` |
| `src/mirror.ts`, `src/settings.ts`, `src/live-mode.ts` | `internal/posture` |
| `src/codex-config.ts`, `src/codex-home.ts` | `internal/codexhome` |
| `src/model.ts`, `src/diagnostics.ts` | `internal/diagnostics` |
| `generated/codex-protocol/ts` | `internal/protocol` (generated) |

**Protocol bindings.** `mise run regen-protocol` keeps writing the TS and JSON
schema from the installed codex. A Go generator then reads
`generated/codex-protocol/schema` and emits `internal/protocol/*.go` for an
allowlist of the types we use (plus whatever they reference). The `git diff`
after a codex upgrade still shows the protocol change. `mise run check` fails
if the generated Go is out of date.

**Strict only about what we own; lenient about everything else.** The other
ports got stricter everywhere, and that broke one of them: Portical hardcoded
Docker's API as `v1.41`, so Docker 29, whose minimum is 1.44, rejects every
call (portical#13; Tidewaiter has the same constant). Being strict is right
for our own config. Applied to someone else's API, it means a new release for
every minor upgrade on their side. So the line is who owns the format:

*Ours, so strict:* the arguments of dragoman's own MCP tools, its flags and
environment, the live-mode file, everything under `~/.dragoman`. A wrong
value is an error that names the field.

*Theirs, so lenient:* the Codex app-server protocol, Claude Code's
settings.json and hook input, MCP's `initialize`, Codex's `config.toml`
and `auth.json`. For each of these:
- **No pinned versions.** Never hardcode a protocol or API version, and never
  refuse a codex whose version we haven't seen. Use what the other side offers
  in its handshake (MCP's protocol version comes from the SDK's negotiation),
  and feature-detect rather than checking version numbers.
- **Unknown fields are ignored** (`encoding/json`'s default; never
  `DisallowUnknownFields`).
- **An unknown enum value or union variant decodes to `Unknown`**, which keeps
  the raw JSON. It is logged once and passed over, or shown as-is: an
  unfamiliar `ThreadItem` appears in the heartbeat under its type name, it
  doesn't stop the run.
- **A missing optional field gets its zero value or a default**, not an error.
  Only the fields dragoman actually needs to do its job are required, and
  missing one fails that call with a message naming what codex sent, never the
  whole server.
- **A setting we don't recognise is left alone**, not refused. A new Claude
  permission mode we can't map gets the most cautious posture (`default`'s:
  every write asks) and one warning, never a startup failure.
- **Tests pin the leniency.** For each external input, a fixture with an extra
  field, an unknown enum value and a missing optional field, asserting each
  still works. These come from the current schema plus edits, so the next
  codex release can't be the first time we find out.

**Seams.** The app-server connection is an interface over a pair of pipes, so
`test/fakes/app-server.ts` becomes an in-process fake on `io.Pipe`. The
scripted elicitation fake ports directly. A `Container` struct, wired in
`main.go`, whose parts a test replaces before `Wire()`, as in Treesinger.

**Tests.**
- The 11 unit test files are ported one to one into `_test.go` files beside
  their packages.
- The integration tests (`test/integration`) import the internals directly,
  not through MCP stdio, so they are ported too, behind
  `//go:build integration`. The `verifyOnce` ratchet carries over: the marker
  is a hash of the test name plus the test file's contents, and the test skips
  when `codex` is not on PATH.
- The `*.experiment.ts` files are one-off investigations and are not ported.
  They stay in git history.

**Parity checks before replacing anything.**
- The `tools/list` output of both servers, diffed as JSON: identical names,
  descriptions and schemas.
- Same on-disk state: `~/.dragoman/runs`, the codex home that `codexhome` builds,
  the live-mode directory. A thread started under the TS build continues under
  the Go build, and the other way round.
- Run the Go build as the plugin for a few days of normal use (via a local
  `directory` marketplace) before the swap.

## Step 2 — replace the TypeScript

- Delete `src/`, `test/` (TS), `scripts/*.ts`, `package.json`, `bun.lock`,
  `tsconfig.json`, `generated/codex-protocol/ts` (the schema stays, since it is
  the generator's input), `packaging/*.sh`.
- `./run` becomes a POSIX script, as in Treesinger, with the major version in
  `MAJOR`. The version scheme stays the same: `MAJOR.<commit count>.<run number
  or timestamp>`, still refusing a shallow clone. MAJOR stays 1, because the
  plugin's tools and settings don't change.
- The README's install section: no bun; Linux and Apple-silicon macOS; Windows
  through WSL.

## Step 3 — CI on both platforms

`ci.yml` becomes a matrix of `ubuntu-latest` and `macos-latest`:
- both run `mise run check` (gofmt, vet, `go test ./...`, generated Go up to
  date);
- both install `codex` and run the integration tests that need no model call
  (`sandbox`, `filesystem`, `execpolicy`, `profile`; these use `command/exec`,
  are free and deterministic), but only if spike 3 shows `command/exec` works
  logged out. This is the evidence that the posture mapping holds under
  Seatbelt on macOS as well as Landlock/bubblewrap on Linux. If it needs a
  login, they stay local-only: run them once on a Mac by hand before the swap,
  and note in the README which platform last passed them;
- the integration tests that need a model turn (`approval`,
  `continue-review`, `longpoll`, `webfetch`) stay local, as now;
- `mise run dist` (Linux runner): the three binaries, the zip, `SHA256SUMS`;
  the macOS job tests the darwin binary from that zip, not one it built itself.

## Step 4 — the release machinery the other repos have

- `RELEASE_PATHS` in mise.toml and `mise run release-due`. A release happens
  only when something it is built from changed, or a dispatch asks for one.
- Release notes written from the commits since the last release; the zip and
  `SHA256SUMS` signed with cosign. The marketplace-pointer commit stays as it is.
- The Weekly update: mise tools to the latest patch of their minor, Go modules,
  committed straight to main once CI passes with them.
- A Channels section in the README in the shape every repo uses.

## Risks

- **The Go MCP SDK may not support server-initiated elicitation as needed.**
  The fallback is a hand-written MCP server (see step 0.1). It is small, since
  dragoman uses four methods.
- **Protocol churn.** Mitigated by generating from the schema and by being
  lenient about what we don't own (see step 1). The generated types must not
  turn that leniency into strictness: optional schema fields become pointers
  or `omitempty`, and enums are open string types with known constants, never
  a closed set that fails to decode. Keep `regen-protocol`, then the generator, as the one move after a
  codex upgrade.
- **macOS has never been tested.** CI has only ever run on Linux, so step 3's
  macOS job is new coverage, not a check for regressions. Expect differences between Seatbelt and Linux's sandbox to turn
  up there rather than as a result of the port.
