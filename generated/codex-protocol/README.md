# Codex app-server protocol bindings (generated)

**Do not hand-edit.** These are [ts-rs](https://github.com/Aleph-Alpha/ts-rs)
bindings and JSON Schemas for OpenAI Codex's `app-server` JSON-RPC protocol,
generated from the installed `codex` CLI and committed so Dragoman builds and
tests without a `codex` binary present.

- `ts/` — TypeScript types, one file per protocol type. `ts/index.ts` is a
  barrel re-export; import from there (`generated/codex-protocol/ts/index.ts`).
- `schema/` — the JSON Schema bundle for the same types.

## Pinned version

Last generated against **`codex-cli 0.150.1`**.

## Regenerating

After a `codex` upgrade, run:

```
mise run regen-protocol
```

which runs, under the hood:

```
codex app-server generate-ts          --out generated/codex-protocol/ts     --experimental
codex app-server generate-json-schema --out generated/codex-protocol/schema --experimental
```

The resulting `git diff` **is** the protocol change between the two `codex`
versions — review it as you would any other change. Update the pinned version
above when you regenerate.

## Wire notes (not obvious from the types)

- Framing is **NDJSON**: one complete JSON object per line, `\n`-terminated.
  Not LSP `Content-Length` framing.
- The dialect is JSON-RPC-*like* but carries **no `jsonrpc` field**. Messages:
  request `{id, method, params}`, response `{id, result}`, error
  `{id, error: {code, message, data?}}`, notification `{method, params}` with
  an optional top-level `emittedAtMs`.
