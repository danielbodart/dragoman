import { describe, expect, test } from "bun:test";
import { lines } from "../src/codex.ts";

/** Turn a list of strings into an async byte stream, chunked exactly as given. */
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
  test("splits whole lines delivered in one chunk", async () => {
    expect(await collect(lines(bytes('{"a":1}\n{"b":2}\n')))).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("reassembles a line split across chunks", async () => {
    // The whole point: the app-server delivers bytes in arbitrary chunks, so a
    // JSON object can be torn in half mid-line and must be held back until the
    // newline arrives.
    expect(await collect(lines(bytes('{"a":', '1}\n')))).toEqual(['{"a":1}']);
  });

  test("holds back a trailing partial line with no newline", async () => {
    // A final unterminated fragment is not a line yet — dropping it silently is
    // correct (the next chunk completes it); yielding it would emit invalid JSON.
    expect(await collect(lines(bytes('{"a":1}\n{"b'))).then((l) => l)).toEqual(['{"a":1}']);
  });

  test("emits several lines from a single chunk", async () => {
    expect(await collect(lines(bytes('{"a":1}\n{"b":2}\n{"c":3}\n')))).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  test("skips blank lines rather than yielding empty strings", async () => {
    expect(await collect(lines(bytes('{"a":1}\n\n{"b":2}\n')))).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("trims surrounding whitespace on each line", async () => {
    expect(await collect(lines(bytes('  {"a":1}  \n')))).toEqual(['{"a":1}']);
  });
});
