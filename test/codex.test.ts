import { describe, expect, test } from "bun:test";
import { AppServerProcess, lines } from "../src/codex.ts";

/** Turn strings into a chunked async byte stream. */
async function* bytes(...chunks: string[]): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  for (const chunk of chunks) yield encoder.encode(chunk);
}
async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of stream) out.push(line);
  return out;
}

describe("lines", () => {
  test("reassembles a line split across chunks and drops a trailing partial", async () => {
    expect(await collect(lines(bytes('{"a":', '1}\n{"b'))).then((l) => l)).toEqual(['{"a":1}']);
  });
});

describe("AppServerProcess subprocess death", () => {
  test("a subprocess that exits without answering rejects the pending request, never hangs", async () => {
    // The critical regression: on a clean stdout EOF (the normal way a process
    // exit presents), the read loop completes WITHOUT throwing. If pending
    // requests aren't failed in `finally`, `request()` hangs forever — the exact
    // hang this project exists to remove, recreated on subprocess death. Point
    // the conn at a process that reads nothing and exits immediately; the
    // in-flight `initialize` request inside start() must reject, not hang.
    const start = AppServerProcess.start(["true"]); // `true` exits 0 at once, sends no bytes
    await expect(start).rejects.toThrow(/codex app-server exited|connection closed/);
  });
});
