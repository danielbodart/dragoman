/**
 * TEMPORARY experiment: can the MCP *client* (Claude Code) answer a server-issued
 * sampling request, and can its `auto` mode do so WITHOUT a human?
 *
 * This is the linchpin for routing Codex's approvals back to Claude's own model
 * (the faithful `auto` mirror). The elicitation seam is human-only, so sampling
 * (`sampling/createMessage`) — which targets the client's LLM — is the only
 * candidate channel. The SDK also offers a tools-enabled variant ("tool
 * request"), which is the shape most likely to be auto-answerable.
 *
 * It reports three things: what the client advertised at init, whether a plain
 * sampling call is answered, and whether the tools variant is answered. Delete
 * once the approval-routing design is settled.
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

/** Bound so a stuck request (e.g. waiting on a human) returns instead of hanging the tool call. */
const PROBE_TIMEOUT_MS = 60_000;

export async function samplingProbe(server: Server): Promise<string> {
  const lines: string[] = [];
  lines.push("=== Dragoman sampling probe ===\n");

  const caps = server.getClientCapabilities();
  lines.push("client capabilities: " + JSON.stringify(caps ?? null));
  lines.push("  sampling advertised:    " + (caps?.sampling ? "YES" : "no"));
  lines.push("  elicitation advertised: " + (caps?.elicitation ? "YES" : "no"));
  lines.push("");

  lines.push("-- createMessage (plain, no tools) --");
  try {
    const res = await server.createMessage(
      {
        messages: [{ role: "user", content: { type: "text", text: "Reply with exactly: OK" } }],
        maxTokens: 16,
      },
      { timeout: PROBE_TIMEOUT_MS },
    );
    lines.push("  ANSWERED. result: " + JSON.stringify(res));
  } catch (error) {
    lines.push("  FAILED: " + (error as Error).message);
  }
  lines.push("");

  lines.push('-- createMessage (with tools — the "tool request" variant) --');
  try {
    // Loosely typed: the tools overload's generics fight a plain literal, and
    // this is a throwaway probe. We only care whether the client services it.
    const call = server.createMessage.bind(server) as (p: unknown, o?: unknown) => Promise<unknown>;
    const res = await call(
      {
        messages: [
          {
            role: "user",
            content: { type: "text", text: 'Call the "approve" tool with decision "allow".' },
          },
        ],
        maxTokens: 64,
        tools: [
          {
            name: "approve",
            description: "Record an approval decision.",
            inputSchema: {
              type: "object",
              properties: { decision: { type: "string", enum: ["allow", "deny"] } },
              required: ["decision"],
            },
          },
        ],
      },
      { timeout: PROBE_TIMEOUT_MS },
    );
    lines.push("  ANSWERED. result: " + JSON.stringify(res));
  } catch (error) {
    lines.push("  FAILED: " + (error as Error).message);
  }

  return lines.join("\n");
}
