// Package run is the run registry and the background pump: a codex_run's
// lifecycle from thread/start to its terminal event, the approvals routed to
// the human on the way, and the sparse heartbeat codex_status drains.
package run

import (
	"encoding/json"

	"github.com/danielbodart/dragoman/internal/posture"
)

// Event is one entry in a run's single timeline: everything a run tells the
// caller, whichever inbound channel produced it. Every producer appends one;
// codex_status drains them in order and returns them as structuredContent.
//
// A field the source already separated (a path, an exit code, a tool name)
// stays its own field; the only free text is a message's: Codex's own words.
//
// Kinds:
//   - command: a shell command that failed (non-zero exit, failed, declined).
//   - edit: a file patch, each file by path and change kind.
//   - mcpTool: an MCP tool call that failed.
//   - plan: Codex's plan text.
//   - autoApproval: the guardian auto-refusing, with risk and action.
//   - approval: a human approval, waiting then resolved with the decision.
//   - message: Codex's words mid-run, with its phase when given.
//   - result: the terminal outcome: final message, turn status, duration.
//   - error: the terminal failure.
type Event struct {
	Kind       string
	At         int64
	Command    string
	Status     string
	ExitCode   *int64
	DurationMs *int64
	Files      []EditFile
	Server     string
	Tool       string
	Error      string
	Text       *string
	Decision   string
	Risk       string
	Action     string
	Phase      string
	What       string
	Message    string
	Details    string
}

// EditFile is one file of an edit.
type EditFile struct {
	Path   string `json:"path"`
	Change string `json:"change"`
}

// MarshalJSON writes exactly the fields an event of its kind carries, as the
// TypeScript did: required ones always, optional ones when set.
func (e Event) MarshalJSON() ([]byte, error) {
	m := ordered{{"kind", e.Kind}, {"at", e.At}}
	opt := func(key string, v any, present bool) {
		if present {
			m = append(m, kv{key, v})
		}
	}
	switch e.Kind {
	case "command":
		m = append(m, kv{"command", e.Command}, kv{"status", e.Status})
		opt("exitCode", e.ExitCode, e.ExitCode != nil)
		opt("durationMs", e.DurationMs, e.DurationMs != nil)
	case "edit":
		files := e.Files
		if files == nil {
			files = []EditFile{}
		}
		m = append(m, kv{"files", files}, kv{"status", e.Status})
	case "mcpTool":
		m = append(m, kv{"server", e.Server}, kv{"tool", e.Tool}, kv{"status", e.Status})
		opt("durationMs", e.DurationMs, e.DurationMs != nil)
		opt("error", e.Error, e.Error != "")
	case "plan":
		m = append(m, kv{"text", str(e.Text)})
	case "autoApproval":
		m = append(m, kv{"decision", e.Decision})
		opt("risk", e.Risk, e.Risk != "")
		m = append(m, kv{"action", e.Action})
	case "approval":
		m = append(m, kv{"phase", e.Phase}, kv{"what", e.What})
		opt("decision", e.Decision, e.Decision != "")
	case "message":
		m = append(m, kv{"text", str(e.Text)})
		opt("phase", e.Phase, e.Phase != "")
	case "result":
		m = append(m, kv{"status", e.Status})
		opt("text", str(e.Text), e.Text != nil)
		opt("durationMs", e.DurationMs, e.DurationMs != nil)
	case "error":
		m = append(m, kv{"message", e.Message})
		opt("details", e.Details, e.Details != "")
	}
	return m.MarshalJSON()
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

type kv struct {
	key   string
	value any
}

// ordered is a JSON object that keeps its keys in order.
type ordered []kv

func (o ordered) MarshalJSON() ([]byte, error) {
	b := []byte{'{'}
	for i, f := range o {
		if i > 0 {
			b = append(b, ',')
		}
		k, _ := json.Marshal(f.key)
		v, err := json.Marshal(f.value)
		if err != nil {
			return nil, err
		}
		b = append(append(append(b, k...), ':'), v...)
	}
	return append(b, '}'), nil
}

// Usage is a usage snapshot, every field a percentage used (0-100), rounded.
// 5h and 7d are account-wide rate-limit windows; Ctx is this thread's
// context occupancy.
type Usage struct {
	FiveHour *int `json:"5h,omitempty"`
	SevenDay *int `json:"7d,omitempty"`
	Ctx      *int `json:"ctx,omitempty"`
}

// Status is where a run is in its lifecycle. waiting-approval is the state
// this project exists for: an elicitation is in front of the user and the
// run is parked, not hung.
type Status string

const (
	Starting        Status = "starting"
	Running         Status = "running"
	WaitingApproval Status = "waiting-approval"
	Done            Status = "done"
	Failed          Status = "error"
)

func (s Status) terminal() bool { return s == Done || s == Failed }

// Record is the bridge's live record of one run. Status is the control
// scalar, latest wins; Events is the append-only log, drained once.
type Record struct {
	Handle               string
	Cwd                  string
	ExecpolicyAmendments [][]string
	DenyPrefixes         [][]string
	CommandFallback      posture.Fallback
	FileChange           posture.Fallback
	Status               Status
	// Ctx is this thread's context occupancy as a percentage, nil until seen.
	Ctx *int
	// TurnID is the active turn's id, the precondition of turn/interrupt and
	// turn/steer.
	TurnID string
	Events []Event
}
