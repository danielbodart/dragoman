/**
 * The Codex app-server as an object, so the whole bridge runs with no daemon and
 * no socket — the same idiom as tidewaiter's FakeDocker: public mutable fields
 * the test sets, readonly recorded-call arrays it asserts on, and an `emit()`
 * that pushes into an async-iterable feed.
 *
 * Beyond FakeDocker it must also drive the second push channel `AppServerConn`
 * exposes — server→client requests — via `emitServerRequest`, which invokes the
 * registered handler and returns what it replied with (the decision the bridge
 * computed), so a test can await exactly that one round-trip while asserting
 * nothing else stalled.
 */
import type { AppServerConn, Notification, ServerRequest } from "../../src/codex.ts";

export class FakeAppServer implements AppServerConn {
  /** Canned results per method, popped FIFO. Set before the call under test. */
  results: Record<string, unknown[]> = {};
  /** Make the next call to a method throw, to exercise a start-up failure. */
  failWith: Record<string, Error> = {};

  /** Every client→server call, in order. */
  readonly requests: { method: string; params: unknown }[] = [];
  /** Every server-request the handler answered, with the reply it gave. */
  readonly serverRequestReplies: { request: ServerRequest; reply: unknown }[] = [];

  private handler?: (request: ServerRequest) => Promise<unknown>;
  private readonly waiting: { resolve: (n?: Notification) => void }[] = [];
  private readonly queue: Notification[] = [];

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    const error = this.failWith[method];
    if (error) throw error;
    return this.results[method]?.shift();
  }

  onServerRequest(handler: (request: ServerRequest) => Promise<unknown>): void {
    this.handler = handler;
  }

  /**
   * Drive a server→client request into the bridge exactly as the socket would,
   * and resolve with the handler's reply once its promise settles.
   */
  async emitServerRequest(request: ServerRequest): Promise<unknown> {
    if (!this.handler) throw new Error("no onServerRequest handler registered");
    const reply = await this.handler(request);
    this.serverRequestReplies.push({ request, reply });
    return reply;
  }

  /** Push a notification into the feed; same waiting/queue idiom as FakeDocker.events(). */
  emit(notification: Notification): void {
    const waiter = this.waiting.shift();
    if (waiter) waiter.resolve(notification);
    else this.queue.push(notification);
  }

  /** End the feed, so a `for await` over `notifications` completes. */
  close(): void {
    const waiter = this.waiting.shift();
    if (waiter) waiter.resolve(undefined);
  }

  get notifications(): AsyncIterable<Notification> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const queued = self.queue.shift();
          if (queued) {
            yield queued;
            continue;
          }
          const next = await new Promise<Notification | undefined>((resolve) => self.waiting.push({ resolve }));
          if (next === undefined) return;
          yield next;
        }
      },
    };
  }
}
