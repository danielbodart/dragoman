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
import type { ClientRequest } from "../generated/codex-protocol/ts/ClientRequest.ts";
import type { ServerNotificationEnvelope } from "../generated/codex-protocol/ts/ServerNotificationEnvelope.ts";
import type { ServerRequest } from "../generated/codex-protocol/ts/ServerRequest.ts";

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
 * tidewaiter's docker.ts `lines()`. Shared by both wire edges' framing.
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
