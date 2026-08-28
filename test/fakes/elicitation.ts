/**
 * The elicitation channel as an object the test controls.
 *
 * `ask()` returns a promise it does NOT resolve until the test calls `answer()`
 * — the stand-in for "the human hasn't clicked yet". That gap is the whole point
 * of the crux test: it proves the pump does not deadlock, and that `codex_status`
 * keeps answering, while an approval sits unanswered in front of the user.
 */
import type { Approval, ElicitationChannel } from "../../src/elicitation.ts";

export class FakeElicitationChannel implements ElicitationChannel {
  /** Every approval asked, in order, for assertions on prompt and offered decisions. */
  readonly asks: Approval[] = [];

  private pending: ((decision: string) => void)[] = [];

  ask(approval: Approval): Promise<string> {
    this.asks.push(approval);
    return new Promise<string>((resolve) => this.pending.push(resolve));
  }

  /** Whether an ask is currently awaiting an answer. */
  get waiting(): boolean {
    return this.pending.length > 0;
  }

  /** Answer the oldest unanswered ask with a decision, as the user's click would. */
  answer(decision: string): void {
    const resolve = this.pending.shift();
    if (!resolve) throw new Error("no elicitation is awaiting an answer");
    resolve(decision);
  }
}
