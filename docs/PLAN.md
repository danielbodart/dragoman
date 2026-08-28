# Dragoman — Plan

_The interpreter between two courts: a local bridge making OpenAI Codex a
native-feeling subagent inside Anthropic's Claude Code._

This is the design and roadmap for the first working version. Everything marked
**verified** below was confirmed against the installed tooling
(`codex-cli 0.150.1`, `claude-code 2.1.250`) during design — via the generated
app-server protocol schema and a live MCP probe — not assumed.

---

## 1. Problem

The official Codex plugin for Claude Code drives Codex but interfaces with it like
a batch job. Two concrete failures:

1. **Approvals hang.** The plugin connects to the Codex app-server, then rejects
   every server→client request (including "may I run this command?") with
   `-32601 Unsupported server request`. Codex never gets an answer, so it stalls —
   the workaround has been `sandbox_mode = "danger-full-access"`. **(verified: the
   root cause is a single unimplemented `handleServerRequest`.)**
2. **Progress is invisible.** The plugin opts out of the app-server's notification
   stream, so Claude sees only a final result blob.

## 2. Why not fork the official plugin

A fork inherits their architecture and their constraints, and caps the ambition at
"their thing, patched." Dragoman is **greenfield** so the design can be right from
the boundaries out — and so it earns its own identity rather than being a patch on
someone else's.

## 3. Why the app-server (and not `mcp-server`)

Codex exposes two interfaces. `codex mcp-server` (stdio MCP) surfaces approvals via
MCP elicitation, which looked like a shortcut — but it is **deprecated and on a
removal path**. On [openai/codex#11816](https://github.com/openai/codex/issues/11816)
(closed as not-planned) a maintainer states:

> "We've announced that the mcp-server is deprecated and will be removed in a future
> release. We recommend using the app server interface instead. We won't be
> prioritizing any bug fixes in the mcp-server, so I'm going to close this issue."

So Dragoman builds on **`codex app-server`** — the JSON-RPC daemon — exclusively.

## 4. Process & isolation model **(verified)**

Codex's app-server is a **machine singleton**:

- `codex app-server daemon start` is get-or-create ("start … if it is not already
  running"), bound to a fixed control socket at
  `~/.codex/app-server-control/app-server-control.sock`.
- `codex agents` browses "all agent sessions on the **shared** local app-server
  daemon."

Isolation is deliberately placed at the **thread**, not the OS process:

- `thread/start` carries its own `approvalPolicy`, `permissions`, `sandbox`,
  `model`, `cwd`.
- `turn/start` can override per turn; there is also a `thread/settings/update`
  method. **So mode is per-turn mutable, not startup-only.**

Running a separate Codex process per project would fight this — N daemons
contending over one `$CODEX_HOME`, sessions DB, auth, and rate-limit state.

**Dragoman's topology:**

```
Claude session A → dragoman A ─┐
Claude session B → dragoman B ─┼──→ [ ONE shared Codex app-server daemon ]
   (each agent call = a thread) ┘        (owns threads; started if absent)
```

- **One thin bridge per Claude session** (lifecycle = session lifecycle → trivial
  state management).
- All bridges connect to the **one shared Codex daemon**, starting it if needed.
- **Each Codex invocation = a thread** on that daemon, configured per project/cwd.
- Multiple agents in one Claude session = multiple threads, not multiple processes.

A single long-lived bridge daemon (mirroring Codex's own topology, for connection
pooling across sessions) is a possible **v2** — only if per-session bridges prove
limiting.

## 5. Approvals — mirror Claude, elicit only on the exception **(verified)**

The core product idea: **Dragoman carries no permission config of its own.** It
reads Claude Code's settings and mirrors them onto Codex, so Codex inherits Claude's
posture. One config, one mental model.

Mapping surface (from the app-server v2 schema):

| Claude Code concept | Codex app-server field | Values |
|---|---|---|
| permission mode / sandbox scope | `sandboxPolicy` · `SandboxMode` | `read-only` · `workspace-write` · `danger-full-access` |
| when to ask | `approvalPolicy` · `AskForApproval` | `untrusted` · `on-request` · `never` |
| per-category permission toggles | `AskForApproval.granular` | `mcp_elicitations`, `sandbox_approval`, `request_permissions`, `rules`, `skill_approval` |
| allow-listed commands / rules | execpolicy amendment | via `acceptWithExecpolicyAmendment` |

Behaviour:

- Dragoman mirrors Claude's mode **per turn** (`turn/start`), or live via
  `thread/settings/update` if Claude's config changes mid-thread.
- When Claude is permissive for a trusted repo, Codex runs at the matching sandbox
  with `approvalPolicy: never` — **hands-off, because Claude's own config said so.**
- Elicitation is the **exception path**: it fires only when Codex hits something the
  mirrored policy can't cover.

### Approvals must fire **asynchronously** **(verified)**

We proved elicitation works on Claude Code 2.1.250: the prompt text, choices, and
fields are fully controllable, and the answer comes back as
`{action:"accept", content:{decision:"acceptForSession"}}` — which maps to Codex's
`accept` / `acceptForSession` / `reject` enum.

**Critical constraint:** a bridge tool call that *blocks* awaiting elicitation hits
Claude Code's ~120s tool-call ceiling, gets backgrounded, and the pending
elicitation is abandoned — the exact "hang" from #11816. Dragoman must therefore
**fire elicitation and return immediately**, delivering the answer to Codex
out-of-band when it arrives. (Verified: the async pattern completes cleanly where
the synchronous one always timed out.)

### Note on auto mode **(verified)**

Claude Code's "auto mode" does **not** auto-answer MCP elicitation — it always
prompts the human. Auto mode governs Claude's *own* tool-permission prompts, not
server-driven questions. Hands-off approval therefore comes from **mirroring
Claude's mode** (e.g. `approvalPolicy: never`), never from relying on auto mode.

## 6. Progress — a filter, not a pipe

The whole point of a subagent is that it does **not** spend the orchestrator's
context. Forwarding Codex's full delta stream back would defeat that. Dragoman
collapses the app-server's ~79 notification types into a **sparse heartbeat** of
coarse one-liners (`editing auth.rs`, `running tests`, `plan: step 2/3`).

- Claude Code receives but does **not display** MCP `notifications/progress`
  **(verified)**, so the heartbeat rides the **subagent-narration** path: the bridge
  keeps the latest status line, the subagent's tool returns it on poll, Claude
  narrates it in its own voice.
- Because each beat costs a little context, beats are **coarse and few** —
  milestones, not a stream. The firehose (token deltas, base64 stdout) is *consumed*
  to build the heartbeat, then dropped.

## 7. Runtime & shape

- **Bun**, compiled to a **single self-contained binary** (`bun build --compile`).
  Users must not need Bun installed.
- Core written as testable pure functions: an HTTP/RPC handler with **dependency
  injection** at the wire edges (the app-server socket, the Claude/MCP channel, the
  clock, the filesystem), so the translation logic is unit-testable without real
  sockets.
- Proper **build, tests, and releases** from the start.

### Testability seam — the fake is an object, not a process

The design borrows a stance proven in a sibling Bun project,
[`tidewaiter`](https://github.com/danielbodart/tidewaiter) (itself lifting the shape
from [`portical`](https://github.com/danielbodart/portical)): **define the seam at the
protocol boundary as a plain interface, so the transport is a value you inject — and
the test double is an in-memory object implementing that interface, with no socket,
port, or subprocess.**

In `tidewaiter` this is one type — `type Handler = (Request) => Promise<Response>` —
and it works so cleanly precisely because Docker's Engine API is request/response
HTTP that merely happens to ride a Unix socket. Bun's `fetch` speaks Unix sockets
natively (`fetch(req, { unix: path })`), so a Unix socket, a TCP endpoint, and an
in-memory fake are all the *same* `Handler` shape: the client above cannot tell which
it is talking to.

Dragoman **cannot reuse `Handler` verbatim**, because Codex's app-server is not
request/response HTTP — it is JSON-RPC over a socket with a **bidirectional** stream:
client→server calls, server→client requests (the `handleServerRequest` approval path,
§5), and the ~79-type notification feed (§6). A `(Request) => Promise<Response>` shape
cannot express "the server pushes me a message I did not ask for." So Dragoman keeps
the *principle* and moves the seam one level up, to a behavioural interface over the
duplex — the direct analogue of `tidewaiter`'s `DockerClient`:

```ts
interface AppServerConn {
  request(method: string, params: unknown): Promise<unknown>;   // client→server RPC
  notifications: AsyncIterable<Notification>;                    // server→client feed
  onServerRequest(                                               // the approval path
    handler: (req: ServerRequest) => Promise<ServerResponse>,
  ): void;
}
```

- A **`FakeAppServer`** implementing this — public mutable state, recorded-call arrays,
  and an `emit()` that pushes a notification or a server-request into the stream — lets
  the two riskiest pieces (the **async approval bridge**, §5; the **heartbeat collapse**,
  §6) be unit-tested with zero real Codex daemon, exactly as `tidewaiter`'s `FakeDocker`
  exercises a whole update flow with no Docker. The async-iterable-plus-`emit` idiom for
  the notification feed is lifted straight from its faked Docker `events()` stream.
- Two disciplines from that lineage carry over below the interface, both born of a
  **kept-alive socket**: **drain every response body** (an unread reply desyncs the next
  frame on a persistent connection — the same instinct as §6 consuming-then-dropping the
  firehose), and treat **timeout as per-call policy** (a decorator over the transport),
  with long-lived calls — the notification stream, a long turn — opting out.
- **Caveat (below the seam, so it does not touch testability):** `tidewaiter` gets framing
  for free because Docker speaks HTTP and Bun's `fetch` handles it. Codex's app-server
  speaks framed JSON-RPC over a raw socket, so Dragoman's lowest layer owns the framing
  itself — `Bun.connect({ unix })` plus a line/`Content-Length` splitter — rather than a
  one-line `fetch` wrapper. This is a little more real-transport code, but the interface
  above it is unchanged, and the fake never sees it.

## 8. Open sub-threads (spike-sized, not blockers)

- Exactly which Claude Code settings a plugin/runtime can read at runtime (keystone
  of the mirroring design).
- Precise alignment between Claude's permission categories and
  `AskForApproval.granular`.
- The simplified companion **icon** (favicon/app-icon derived from the logo — likely
  the two crossed scrolls or the compass mark).
- Licence choice.

## 9. Roadmap

1. **Spike — prove the approval bridge.** Minimal Bun bridge that connects to the
   app-server, starts a thread, runs a turn, and maps a Codex approval request to an
   **async** Claude elicitation. Success = a real Codex task under a normal sandbox
   prompts the user instead of hanging.
2. **Settings mirroring.** Read Claude's settings; map to `sandboxPolicy` +
   `approvalPolicy` (+ granular) on each `turn/start`.
3. **Heartbeat filter.** Collapse notifications to coarse status; surface via
   subagent narration.
4. **Packaging.** Single-binary build, plugin/skill wrapper, tests, release.
5. **(v2, maybe)** Shared bridge daemon for cross-session connection pooling.

---

_Design verified against `codex-cli 0.150.1` and `claude-code 2.1.250` on
2026-08-28. Protocol method names and payload shapes are quoted from the generated
app-server schema and live probe captures, not from memory._
