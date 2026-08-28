/**
 * The Codex app-server edge.
 *
 * `AppServerConn` is the seam (PLAN §7): the JSON-RPC-over-socket duplex as a
 * plain interface, so the transport is injected and a FakeAppServer object —
 * not a real daemon — drives the unit tests. The real socket implementation
 * lives below `SocketAppServerConn` (added in the IO build phase); everything
 * above this interface is transport-blind, the same stance tidewaiter takes with
 * its `Handler` seam over Docker.
 *
 * Wire notes (see generated/codex-protocol/README.md): the app-server speaks
 * NDJSON — one JSON object per line, `\n`-terminated — in a JSON-RPC-*like*
 * dialect with no `jsonrpc` field.
 */
import type { Subprocess } from "bun";
import type { ClientRequest } from "../generated/codex-protocol/ts/ClientRequest.ts";
import type { InitializeParams } from "../generated/codex-protocol/ts/InitializeParams.ts";
import type { ServerNotificationEnvelope } from "../generated/codex-protocol/ts/ServerNotificationEnvelope.ts";
import type { ServerRequest } from "../generated/codex-protocol/ts/ServerRequest.ts";
import { version } from "./version.ts";

/** A server→client notification, carrying its `emittedAtMs` envelope. */
export type Notification = ServerNotificationEnvelope;

/** A server→client request — the approval path this whole bridge exists to answer. */
export type { ServerRequest };

/** The params type of a given client→server request method, from the generated union. */
type ParamsOf<M extends ClientRequest["method"]> = Extract<ClientRequest, { method: M }>["params"];

/**
 * The Codex app-server, as a duplex Dragoman can drive and fake.
 *
 * Three channels, matching the three things the protocol does:
 *  - `request` — client→server RPC (e.g. `thread/start`, `turn/start`).
 *  - `notifications` — the server→client push feed, consumed by exactly one
 *    reader (the pump).
 *  - `onServerRequest` — the server→client request path (approvals). Exactly one
 *    handler, set once: the reply is the promise it returns, so a single owner
 *    is a type-level fact, not a convention.
 */
export interface AppServerConn {
  /**
   * Issue a client→server request and resolve with its result payload.
   *
   * Typed per-method against the generated `ClientRequest` union so callers get
   * the right `params` shape for free. The result stays `unknown` — the
   * generated tree keys responses by their own named types, not by method — so
   * the two callers that need it narrow explicitly (e.g. `as ThreadStartResponse`).
   */
  request<M extends ClientRequest["method"]>(method: M, params: ParamsOf<M>): Promise<unknown>;

  /** The server→client notification feed. One `for await` reader (the pump) drains it. */
  readonly notifications: AsyncIterable<Notification>;

  /**
   * Register the single handler for server→client requests.
   *
   * The handler's returned promise IS the reply: the transport writes
   * `{id, result}` back only once it resolves. Crucially the transport must keep
   * reading the socket while that promise is pending — a slow approval must not
   * stall notifications — which is exactly the hang the official plugin caused
   * by answering synchronously with `-32601`.
   */
  onServerRequest(handler: (request: ServerRequest) => Promise<unknown>): void;
}

/**
 * Split a chunked byte stream into trimmed, non-empty NDJSON lines.
 *
 * This is the one framing job tidewaiter gets for free from `fetch` and Dragoman
 * must own itself (PLAN §7): the app-server delivers bytes in arbitrary chunks,
 * not whole lines, so partial lines are held back across chunks. Ported from
 * tidewaiter's docker.ts `lines()`. Only the Codex edge needs this — the MCP
 * edge hands framing to the SDK's `StdioServerTransport`.
 */
export async function* lines(stream: AsyncIterable<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== "") yield line;
    }
  }
}

/** A JSON-RPC-like frame on the wire: no `jsonrpc` field (see the README). */
interface WireMessage {
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { code: number; message: string; data?: unknown };
}

/**
 * The real `AppServerConn`, over a `codex app-server` subprocess.
 *
 * Transport note (verified against codex-cli 0.150.1): the plain-NDJSON endpoint
 * is the bare `codex app-server` stdio server — NOT the control socket, and NOT
 * `codex app-server proxy`, both of which speak a segmented remote-control
 * envelope and silently drop plain NDJSON. So Dragoman spawns `codex app-server`
 * and talks over its stdin/stdout.
 *
 * This duplex has no tidewaiter precedent (tidewaiter never writes to its socket
 * outside `fetch`), so it is hand-built: the process's stdout stream feeds
 * `lines()`, and outbound frames are written to its stdin. One dispatch loop
 * classifies every inbound frame:
 *   - `id` + (`result`|`error`)  → resolve/reject a pending `request()`.
 *   - `id` + `method`            → a server→client request: run the handler, and
 *                                  write `{id, result}` back ONLY when its promise
 *                                  settles — while the loop keeps draining. That
 *                                  non-blocking reply is the anti-hang property.
 *   - `method`, no `id`          → a notification: push to the feed.
 */
export class AppServerProcess implements AppServerConn {
  private nextId = 1;
  private readonly pending = new Map<string | number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private handler?: (request: ServerRequest) => Promise<unknown>;
  private readonly feed = new AsyncQueue<Notification>();

  private constructor(private readonly proc: Subprocess<"pipe", "pipe", "inherit">) {}

  /**
   * Spawn `codex app-server` and complete the handshake, so callers get back a
   * conn that is already initialized (`initialize` + `initialized`). Opting into
   * `experimentalApi` unlocks the v2 methods. `command` is injectable for tests
   * and for pointing at a specific codex binary.
   */
  static async start(command: readonly string[] = ["codex", "app-server"]): Promise<AppServerProcess> {
    const proc = Bun.spawn(command as string[], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit", // codex diagnostics pass through to our stderr, never onto the protocol
    });

    const conn = new AppServerProcess(proc);
    void conn.dispatch(streamBytes(proc.stdout)); // the one read loop, alive for the process's life

    const params: InitializeParams = {
      clientInfo: { name: "dragoman", title: "Dragoman", version },
      capabilities: { experimentalApi: true, requestAttestation: false },
    };
    await conn.request("initialize", params);
    conn.notify("initialized");
    return conn;
  }

  request<M extends ClientRequest["method"]>(method: M, params: ParamsOf<M>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  get notifications(): AsyncIterable<Notification> {
    return this.feed;
  }

  onServerRequest(handler: (request: ServerRequest) => Promise<unknown>): void {
    this.handler = handler;
  }

  /** Stop the subprocess and abandon anything in flight. */
  close(): void {
    for (const { reject } of this.pending.values()) reject(new Error("connection closed"));
    this.pending.clear();
    this.feed.close();
    this.proc.kill();
  }

  /** The single inbound read loop: frame, classify, dispatch. */
  private async dispatch(bytes: AsyncIterable<Uint8Array>): Promise<void> {
    let failure: Error | undefined;
    try {
      for await (const line of lines(bytes)) {
        let message: WireMessage;
        try {
          message = JSON.parse(line) as WireMessage;
        } catch {
          continue; // a garbled line is skipped rather than killing the loop
        }
        this.route(message);
      }
    } catch (error) {
      failure = error as Error;
    } finally {
      // The subprocess ended — whether by a stdout error OR a clean EOF (the
      // normal way an exit presents, where the `for await` completes without
      // throwing). EITHER way, everything in flight must be failed, or a pending
      // request() hangs forever: the exact hang this project exists to remove,
      // recreated on the subprocess-death path. So this lives in `finally`, not
      // the `catch`, and fails the feed too so the pump loop sees it.
      const error = failure ?? new Error("codex app-server exited");
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
      this.feed.fail(error);
    }
  }

  private route(message: WireMessage): void {
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${message.error.code}: ${message.error.message}`));
      else waiter.resolve(message.result);
      return;
    }

    if (message.id !== undefined && message.method !== undefined) {
      // A server→client request. Answer WITHOUT blocking the loop: the reply is
      // written when the handler's promise settles; meanwhile we return and keep
      // reading. This is the fix for the plugin's synchronous -32601 hang.
      const id = message.id;
      const request = message as unknown as ServerRequest;
      // No handler yet → a JSON-RPC error, not a guessed `{decision}` result:
      // we can't know the right response shape for this method, and a wrong
      // result is worse than a well-formed error the server can act on.
      const answer = this.handler
        ? this.handler(request)
        : Promise.reject(new Error("no server-request handler registered"));
      void answer
        .then((result) => this.write({ id, result }))
        .catch((error: unknown) => this.write({ id, error: { code: -32603, message: errorMessage(error) } }));
      return;
    }

    if (message.method !== undefined) {
      this.feed.push(message as Notification);
    }
  }

  private notify(method: string): void {
    this.write({ method });
  }

  private write(message: WireMessage): void {
    // A write can lose its race with shutdown: an approval handler may resolve
    // (and try to reply) after close() has killed the subprocess. That is
    // expected here, not exceptional — swallow the resulting write error rather
    // than letting it surface as an unhandled rejection from route()'s reply chain.
    try {
      this.proc.stdin.write(JSON.stringify(message) + "\n");
      this.proc.stdin.flush();
    } catch {
      // subprocess already gone; nothing to write to
    }
  }
}

/** A message string for any thrown value, not just an `Error` (a thrown string would read undefined). */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Adapt a Bun ReadableStream (the subprocess stdout) to an AsyncIterable of chunks. */
async function* streamBytes(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * A minimal async queue bridging callback-driven producers (Bun's socket `data`
 * callback, the frame router) to `for await` consumers. Buffers when the
 * consumer is behind, parks when it is ahead, and ends cleanly on close/fail.
 */
class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: { resolve: (r: IteratorResult<T>) => void; reject: (e: Error) => void }[] = [];
  private ended = false;
  private failure?: Error;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.buffer.push(value);
  }

  close(): void {
    if (this.ended) return; // first ending wins; a later fail() can't reopen a clean close
    this.ended = true;
    for (const waiter of this.waiters) waiter.resolve({ value: undefined, done: true });
    this.waiters.length = 0;
  }

  fail(error: Error): void {
    if (this.ended) return; // idempotent: a clean close() already ended us, don't turn it into a failure
    this.failure = error;
    this.ended = true;
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.length = 0;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift()!;
        continue;
      }
      if (this.failure) throw this.failure;
      if (this.ended) return;
      const result = await new Promise<IteratorResult<T>>((resolve, reject) => this.waiters.push({ resolve, reject }));
      if (result.done) return;
      yield result.value;
    }
  }
}
