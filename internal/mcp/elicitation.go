package mcp

import (
	"context"
	"encoding/json"
	"slices"

	"github.com/danielbodart/dragoman/internal/run"
)

// Elicitation is run.Elicitation over the MCP server's elicitation/create.
//
// An approval is a one-field form: an enum of the decision ids Codex offered.
// Claude Code shows the prompt and the choices natively, and the reply
// {action: "accept", content: {decision}} carries the pick back. A decline or
// cancel action, the user dismissing the prompt, maps to Codex's "cancel", so
// the pump always has a valid decision to send on.
//
// It waits as long as the human takes. (The TypeScript SDK gave up after its
// default 60s request timeout.)
type Elicitation struct {
	Server *Server
}

// Ask puts the approval in front of the human.
func (e Elicitation) Ask(ctx context.Context, a run.Approval) (string, error) {
	decisions := a.Decisions
	if len(decisions) == 0 {
		decisions = []string{"accept", "decline"}
	}
	params := map[string]any{
		"mode":    "form",
		"message": a.Prompt,
		"requestedSchema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"decision": map[string]any{
					"type":        "string",
					"title":       "Decision",
					"description": "How Codex should proceed.",
					"enum":        decisions,
				},
			},
			"required": []string{"decision"},
		},
	}
	raw, err := e.Server.Elicit(ctx, params)
	if err != nil {
		return "", err
	}
	var result struct {
		Action  string `json:"action"`
		Content struct {
			Decision any `json:"decision"`
		} `json:"content"`
	}
	_ = json.Unmarshal(raw, &result)
	if result.Action != "accept" {
		return "cancel", nil
	}
	if chosen, ok := result.Content.Decision.(string); ok && slices.Contains(decisions, chosen) {
		return chosen, nil
	}
	return "cancel", nil
}
