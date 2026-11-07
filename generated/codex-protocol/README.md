# Codex app-server protocol bindings (generated)

**Do not hand-edit.** This is the JSON Schema for OpenAI Codex's `app-server`
JSON-RPC protocol, generated from the installed `codex` CLI and committed so
Dragoman builds and tests without a `codex` binary present.

- `schema/` — the JSON Schema, one file per root type plus the bundles.
  `internal/protocol/gen` reads `codex_app_server_protocol.schemas.json` and
  writes the Go types Dragoman uses to `internal/protocol/protocol_gen.go`;
  `mise run check` fails if that file is out of date.

## Pinned version

Last generated against **`codex-cli 0.150.1`**.

## Regenerating

After a `codex` upgrade, run:

```
mise run regen-protocol
```

which runs, under the hood:

```
codex app-server generate-json-schema --out generated/codex-protocol/schema --experimental
go run ./internal/protocol/gen
```

The resulting `git diff` (the schema, and the Go generated from it) **is** the
protocol change between the two `codex` versions — review it as you would any other change. Update the pinned version
above when you regenerate.

## Wire notes (not obvious from the types)

- Framing is **NDJSON**: one complete JSON object per line, `\n`-terminated.
  Not LSP `Content-Length` framing.
- The dialect is JSON-RPC-*like* but carries **no `jsonrpc` field**. Messages:
  request `{id, method, params}`, response `{id, result}`, error
  `{id, error: {code, message, data?}}`, notification `{method, params}` with
  an optional top-level `emittedAtMs`.
