/**
 * The Claude-facing approval seam.
 *
 * When Codex asks to do something the mirrored policy can't auto-answer, the
 * pump needs to put a question in front of the human and get a decision back.
 * `ElicitationChannel` is that ask, as a plain interface — so the pump is tested
 * against a fake that resolves on command, and the real MCP `elicitation/create`
 * plumbing (and the fact it rides the `@modelcontextprotocol/sdk` `Server`)
 * stays behind this one seam, exactly as `AppServerConn` hides the socket.
 *
 * The channel speaks in Codex's own decision vocabulary, not MCP's: the pump
 * hands it the decisions Codex offered and gets one back, and the real
 * implementation is responsible for translating that to/from an MCP form (an
 * enum field whose accepted values are these decision ids).
 */
import type { ElicitRequestFormParams, ElicitResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * One approval question and the decisions the user may pick.
 *
 * `decisions` are Codex's own decision ids for this request (e.g. "accept",
 * "acceptForSession", "decline"), in the order Codex asked them to be offered.
 */
export interface Approval {
  /** The human-facing prompt, e.g. "Codex wants to run `rm -rf build/` in /repo". */
  readonly prompt: string;
  /** The decision ids to offer, from the request's `availableDecisions`. */
  readonly decisions: readonly string[];
}

/**
 * How the user answered: the chosen decision id, or a dismissal.
 *
 * `"decline"`/`"cancel"` are Codex decisions in their own right, but the MCP
 * layer can also report an outright dismissal (the user closed the prompt) — the
 * real implementation maps those onto `"cancel"` so the pump always has a valid
 * Codex decision to send back.
 */
export interface ElicitationChannel {
  /** Ask the human, resolving with the chosen decision id. Never rejects on a normal answer. */
  ask(approval: Approval): Promise<string>;
}

/**
 * The real channel, over the MCP `Server`'s `elicitation/create`.
 *
 * The approval is surfaced as a one-field form: an enum whose values are the
 * Codex decision ids Codex offered. Claude Code shows the prompt and the choices
 * natively; the `{action:"accept", content:{decision}}` reply carries the picked
 * decision id straight back (matching the shape the PLAN's probe verified). A
 * `decline`/`cancel` action — the user dismissing the prompt — maps to Codex's
 * `"cancel"`, so the pump always gets a valid decision to send on.
 *
 * The SDK's `Server` is imported only here (as a type); the pump depends on the
 * `ElicitationChannel` interface above, never on the SDK.
 */
export class McpElicitationChannel implements ElicitationChannel {
  constructor(private readonly server: Elicitor) {}

  async ask(approval: Approval): Promise<string> {
    const decisions = approval.decisions.length > 0 ? approval.decisions : ["accept", "decline"];
    const result = await this.server.elicitInput({
      message: approval.prompt,
      requestedSchema: {
        type: "object",
        properties: {
          decision: {
            type: "string",
            title: "Decision",
            description: "How Codex should proceed.",
            enum: [...decisions],
          },
        },
        required: ["decision"],
      },
    });

    if (result.action !== "accept") return "cancel";
    const chosen = result.content?.decision;
    return typeof chosen === "string" && decisions.includes(chosen) ? chosen : "cancel";
  }
}

/** Just the one method of the SDK `Server` this channel needs — a `Server` satisfies it. */
export interface Elicitor {
  elicitInput(params: ElicitRequestFormParams): Promise<ElicitResult>;
}
