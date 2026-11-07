package run

// The heartbeat filter: the notification firehose collapsed to a sparse
// sequence of structured events.
//
// Significant means something the driving agent would act on or relay: a
// file edit, Codex's plan, or a step that went wrong (a failed command or MCP
// call, a refused auto-approval). Routine success is not an event: each
// event wakes a parked codex_status and costs the driving agent a model turn
// over its whole context. One 6h run woke 2,803 times, ~95% of them for
// routine commands and auto-approvals, before this rule.
//
// This handles the non-terminal, thread-scoped milestones only; terminal
// outcomes, Codex's messages and the human-approval lifecycle are folded in by
// the pump, which owns run status and dedupe.

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/danielbodart/dragoman/internal/codex"
	"github.com/danielbodart/dragoman/internal/protocol"
)

// ThreadIDOf is the threadId a notification concerns, or "" for a feed-wide
// one.
func ThreadIDOf(n codex.Notification) string {
	var p struct {
		ThreadID any `json:"threadId"`
	}
	_ = json.Unmarshal(n.Params, &p)
	id, _ := p.ThreadID.(string)
	return id
}

// at is when the source emitted n, or now.
func at(n codex.Notification) int64 {
	if n.EmittedAtMs != nil {
		return *n.EmittedAtMs
	}
	return time.Now().UnixMilli()
}

// EventOf is the event for a notification, if it is a milestone.
func EventOf(n codex.Notification) (Event, bool) {
	when := at(n)
	switch n.Method {
	case "item/started", "item/completed":
		var p protocol.ItemCompletedNotification
		if protocol.Decode(n.Params, &p) != nil {
			return Event{}, false
		}
		return itemEvent(p.Item, n.Method == "item/completed", when)
	case "item/autoApprovalReview/completed":
		var p protocol.ItemGuardianApprovalReviewCompletedNotification
		if protocol.Decode(n.Params, &p) != nil {
			return Event{}, false
		}
		// A guardian approval is routine; only a refusal is news.
		if p.Review.Status == "approved" {
			return Event{}, false
		}
		e := Event{Kind: "autoApproval", At: when, Decision: string(p.Review.Status), Action: actionSummary(p.Action)}
		if p.Review.RiskLevel != nil {
			e.Risk = string(*p.Review.RiskLevel)
		}
		return e, true
	}
	return Event{}, false
}

// actionSummary is a short label for what an auto-approval decided on. An
// action this code doesn't know is shown by its type name.
func actionSummary(a protocol.GuardianApprovalReviewAction) string {
	switch {
	case a.Command != nil:
		return a.Command.Command
	case a.Execve != nil:
		return strings.Join(append([]string{a.Execve.Program}, a.Execve.Argv...), " ")
	case a.WriteStdin != nil:
		return "write stdin"
	case a.ApplyPatch != nil:
		return "patch " + itoa(int64(len(a.ApplyPatch.Files))) + " file(s)"
	case a.NetworkAccess != nil:
		return "network " + a.NetworkAccess.Host + ":" + itoa(a.NetworkAccess.Port)
	case a.McpToolCall != nil:
		return a.McpToolCall.Server + "." + a.McpToolCall.ToolName
	case a.RequestPermissions != nil:
		return "request permissions"
	}
	return a.Type
}

// itemEvent is the event for a thread item: only edits, plans and failed
// steps. A start of anything is not one, and a kind this code doesn't know
// is not a milestone.
func itemEvent(item protocol.ThreadItem, done bool, when int64) (Event, bool) {
	switch {
	case item.CommandExecution != nil:
		c := item.CommandExecution
		if !done || (c.Status == "completed" && (c.ExitCode == nil || *c.ExitCode == 0)) {
			return Event{}, false
		}
		return Event{Kind: "command", At: when, Command: c.Command, Status: string(c.Status), ExitCode: c.ExitCode, DurationMs: c.DurationMs}, true
	case item.FileChange != nil:
		if !done {
			return Event{}, false
		}
		files := []EditFile{}
		for _, ch := range item.FileChange.Changes {
			files = append(files, EditFile{Path: ch.Path, Change: ch.Kind.Type})
		}
		return Event{Kind: "edit", At: when, Files: files, Status: string(item.FileChange.Status)}, true
	case item.Plan != nil:
		if !done {
			return Event{}, false
		}
		text := item.Plan.Text
		return Event{Kind: "plan", At: when, Text: &text}, true
	case item.McpToolCall != nil:
		m := item.McpToolCall
		if !done || m.Status != "failed" {
			return Event{}, false
		}
		e := Event{Kind: "mcpTool", At: when, Server: m.Server, Tool: m.Tool, Status: string(m.Status), DurationMs: m.DurationMs}
		if m.Error != nil {
			e.Error = m.Error.Message
		}
		return e, true
	}
	return Event{}, false
}

func itoa(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}
