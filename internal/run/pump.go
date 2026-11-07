package run

// The background pump, the async heart of the bridge. Two jobs, neither on
// the critical path of an MCP tool call:
//
//  1. The approval handler: a server request becomes an Elicitation.Ask, and
//     the chosen decision is the reply. It may take as long as the human
//     does; that is fine, since Codex's own request has no Claude Code
//     deadline, and the connection keeps reading while it waits.
//  2. The notification loop: each notification folded through EventOf into
//     the matching run's timeline, which codex_status drains in order.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/danielbodart/dragoman/internal/codex"
	"github.com/danielbodart/dragoman/internal/posture"
	"github.com/danielbodart/dragoman/internal/protocol"
	"github.com/danielbodart/gokit/logx"
)

// Approval is one question for the human and the decisions to offer, in
// Codex's own vocabulary (accept, acceptForSession, decline, ...), in the
// order Codex asked for them.
type Approval struct {
	Prompt    string
	Decisions []string
}

// Elicitation puts an approval in front of the human and returns the
// decision they picked. The MCP side lives behind it.
type Elicitation interface {
	Ask(ctx context.Context, approval Approval) (string, error)
}

// Pump wires a connection to the registry.
type Pump struct {
	Runs        *Runs
	Elicitation Elicitation
	Log         logx.Logger

	once sync.Map // unknown things logged once
}

// Start registers the approval handler on conn and runs the notification
// loop in the background until the feed ends or ctx is done.
func (p *Pump) Start(ctx context.Context, conn codex.Conn) {
	conn.OnServerRequest(func(req codex.ServerRequest) (any, error) { return p.handle(ctx, req) })
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case n, ok := <-conn.Notifications():
				if !ok {
					return
				}
				p.apply(n)
			}
		}
	}()
}

func (p *Pump) logOnce(key string, args ...any) {
	if _, seen := p.once.LoadOrStore(key, true); !seen && p.Log != nil {
		p.Log.Error(args...)
	}
}

// handle answers one server request with the shape that method expects: a
// typed decision for the approvals, the time for currentTime/read, and for
// anything else an error, which the connection sends as a well-formed
// JSON-RPC error frame. A wrong-shaped result is worse than an error, and an
// error never leaves a request unanswered.
func (p *Pump) handle(ctx context.Context, req codex.ServerRequest) (any, error) {
	switch req.Method {
	case "item/commandExecution/requestApproval":
		var params protocol.CommandExecutionRequestApprovalParams
		if err := protocol.Decode(req.Params, &params); err != nil {
			return nil, fmt.Errorf("%s: %w", req.Method, err)
		}
		return p.commandApproval(ctx, params)
	case "item/fileChange/requestApproval":
		var params protocol.FileChangeRequestApprovalParams
		if err := protocol.Decode(req.Params, &params); err != nil {
			return nil, fmt.Errorf("%s: %w", req.Method, err)
		}
		return p.fileChangeApproval(ctx, params)
	case "item/permissions/requestApproval":
		return p.permissionsApproval(ctx, req.Params)
	case "currentTime/read":
		return protocol.CurrentTimeReadResponse{CurrentTimeAt: time.Now().Unix()}, nil
	}
	return nil, fmt.Errorf("unsupported server request: %s", req.Method)
}

// raise puts a run into waiting-approval and appends the waiting event, so a
// pending approval rides the drained timeline and is never lost at a polling
// boundary: the status alone is a snapshot a fast answer would flip back
// before a coarse poll saw it.
func (p *Pump) raise(threadID, what string) {
	if p.Runs.Update(threadID, func(r *Record) {
		r.Status = WaitingApproval
		r.Events = append(r.Events, Event{Kind: "approval", At: p.Runs.Now(), Phase: "waiting", What: what})
	}) {
		p.Runs.Bump(threadID)
	}
}

// resolve records the answer and leaves the waiting state.
func (p *Pump) resolve(threadID, decision, what string) {
	if p.Runs.Update(threadID, func(r *Record) {
		if r.Status == WaitingApproval {
			r.Status = Running
		}
		r.Events = append(r.Events, Event{Kind: "approval", At: p.Runs.Now(), Phase: "resolved", What: what, Decision: decision})
	}) {
		p.Runs.Bump(threadID)
	}
}

func decision(value string) protocol.CommandExecutionRequestApprovalResponse {
	return protocol.CommandExecutionRequestApprovalResponse{Decision: protocol.CommandExecutionApprovalDecision{Value: value}}
}

// commandApproval: deny wins, then a mirrored allow prefix answers without
// the human, then dontAsk refuses, and everything else asks.
func (p *Pump) commandApproval(ctx context.Context, params protocol.CommandExecutionRequestApprovalParams) (any, error) {
	rec, _ := p.Runs.Status(params.ThreadId)
	command := ""
	if params.Command != nil {
		command = *params.Command
	}
	if isDenied(command, rec.DenyPrefixes) {
		return decision("decline"), nil
	}
	if amendment := matchesPrefix(command, rec.ExecpolicyAmendments); amendment != nil {
		p.Runs.Update(params.ThreadId, func(r *Record) {
			if r.Status == WaitingApproval {
				r.Status = Running
			}
		})
		return protocol.CommandExecutionRequestApprovalResponse{Decision: protocol.CommandExecutionApprovalDecision{
			AcceptWithExecpolicyAmendment: &protocol.AcceptWithExecpolicyAmendmentCommandExecutionApprovalDecision{
				AcceptWithExecpolicyAmendment: protocol.AcceptWithExecpolicyAmendmentCommandExecutionApprovalDecisionAcceptWithExecpolicyAmendment{ExecpolicyAmendment: amendment},
			},
		}}, nil
	}
	if rec.CommandFallback == posture.Decline {
		return decision("decline"), nil
	}

	shown := command
	if params.Command == nil {
		shown = "a command"
	}
	what := "run `" + shown + "`"
	p.raise(params.ThreadId, what)
	chosen, err := p.Elicitation.Ask(ctx, Approval{Prompt: promptFor(params), Decisions: availableDecisions(params)})
	if err != nil {
		return nil, err
	}
	p.resolve(params.ThreadId, chosen, what)
	return decision(chosen), nil
}

// fileChangeApproval: Codex raises it when a write escapes the sandbox.
func (p *Pump) fileChangeApproval(ctx context.Context, params protocol.FileChangeRequestApprovalParams) (any, error) {
	rec, _ := p.Runs.Status(params.ThreadId)
	switch rec.FileChange {
	case posture.Accept:
		return protocol.FileChangeRequestApprovalResponse{Decision: "accept"}, nil
	case posture.Decline:
		return protocol.FileChangeRequestApprovalResponse{Decision: "decline"}, nil
	}
	where, reason := "", ""
	if params.GrantRoot != nil && *params.GrantRoot != "" {
		where = " under `" + *params.GrantRoot + "`"
	}
	if params.Reason != nil && *params.Reason != "" {
		reason = " — " + *params.Reason
	}
	what := "write files" + where
	p.raise(params.ThreadId, what)
	chosen, err := p.Elicitation.Ask(ctx, Approval{
		Prompt:    "Codex wants to write files" + where + reason,
		Decisions: []string{"accept", "acceptForSession", "decline", "cancel"},
	})
	if err != nil {
		return nil, err
	}
	p.resolve(params.ThreadId, chosen, what)
	return protocol.FileChangeRequestApprovalResponse{Decision: protocol.FileChangeApprovalDecision(chosen)}, nil
}

// permissionsGrant is a permissions reply: what was asked, echoed back as
// Codex sent it, or nothing.
type permissionsGrant struct {
	Permissions map[string]json.RawMessage `json:"permissions"`
	Scope       string                     `json:"scope"`
}

// permissionsApproval: the agent asks to widen its sandbox for the rest of
// the turn. The human decides; accept grants exactly what was asked, echoed
// as Codex sent it, anything else an empty profile, which widens nothing.
func (p *Pump) permissionsApproval(ctx context.Context, raw json.RawMessage) (any, error) {
	var params protocol.PermissionsRequestApprovalParams
	if err := protocol.Decode(raw, &params); err != nil {
		return nil, fmt.Errorf("item/permissions/requestApproval: %w", err)
	}
	deny := permissionsGrant{Permissions: map[string]json.RawMessage{}, Scope: "turn"}
	rec, _ := p.Runs.Status(params.ThreadId)
	if rec.CommandFallback == posture.Decline {
		return deny, nil
	}
	what := "expand its permissions"
	p.raise(params.ThreadId, what)
	chosen, err := p.Elicitation.Ask(ctx, Approval{Prompt: permissionsPromptFor(params), Decisions: []string{"accept", "decline"}})
	if err != nil {
		return nil, err
	}
	p.resolve(params.ThreadId, chosen, what)
	if chosen != "accept" {
		return deny, nil
	}
	var asked struct {
		Permissions map[string]json.RawMessage `json:"permissions"`
	}
	_ = json.Unmarshal(raw, &asked)
	granted := map[string]json.RawMessage{}
	for _, key := range []string{"network", "fileSystem"} {
		if v, ok := asked.Permissions[key]; ok && string(v) != "null" {
			granted[key] = v
		}
	}
	return permissionsGrant{Permissions: granted, Scope: "turn"}, nil
}

func permissionsPromptFor(params protocol.PermissionsRequestApprovalParams) string {
	var wants []string
	if n := params.Permissions.Network; n != nil && n.Enabled != nil && *n.Enabled {
		wants = append(wants, "network access")
	}
	if fs := params.Permissions.FileSystem; fs != nil {
		if len(fs.Write) > 0 {
			wants = append(wants, "write: "+strings.Join(fs.Write, ", "))
		}
		if len(fs.Read) > 0 {
			wants = append(wants, "read: "+strings.Join(fs.Read, ", "))
		}
		if len(fs.Entries) > 0 {
			wants = append(wants, fmt.Sprintf("%d path rule(s)", len(fs.Entries)))
		}
	}
	what := "expanded permissions"
	if len(wants) > 0 {
		what = strings.Join(wants, "; ")
	}
	reason := ""
	if params.Reason != nil && *params.Reason != "" {
		reason = " — " + *params.Reason
	}
	return fmt.Sprintf("Codex wants to expand its permissions in `%s`%s: %s", params.Cwd, reason, what)
}

// matchesPrefix is the allow prefix the command matches, if any. Only the
// real command string is trusted, never Codex's own proposed amendment:
// Codex is the party this gate mediates, and letting its proposal skip the
// human would fail open.
func matchesPrefix(command string, prefixes [][]string) []string {
	tokens := simpleCommandTokens(command)
	if tokens == nil {
		return nil
	}
	for _, p := range prefixes {
		if isTokenPrefix(p, tokens) {
			return p
		}
	}
	return nil
}

var safeToken = regexp.MustCompile(`^[A-Za-z0-9_./:=@,+-]+$`)

// simpleCommandTokens is the tokens of a lone simple command (a shell
// wrapper unwrapped), or nil if it is anything more: a chain, substitution,
// redirect, glob, variable or quoting. Auto-approval covers the whole
// command, so `npm run test && rm -rf /` must never ride a `npm run test`
// allow.
func simpleCommandTokens(command string) []string {
	command = strings.TrimSpace(command)
	if command == "" {
		return nil
	}
	source := command
	if inner, ok := unwrapShellScript(command); ok {
		source = inner
	}
	tokens := splitWhitespace(strings.TrimSpace(source))
	if len(tokens) == 0 {
		return nil
	}
	for _, t := range tokens {
		if !safeToken.MatchString(t) {
			return nil
		}
	}
	return tokens
}

// splitWhitespace is JavaScript's s.split(/\s+/): an empty s gives one empty
// token, which no prefix and no safe token matches.
func splitWhitespace(s string) []string {
	fields := strings.Fields(s)
	if len(fields) == 0 {
		return []string{""}
	}
	return fields
}

func isTokenPrefix(prefix, tokens []string) bool {
	if len(prefix) == 0 || len(prefix) > len(tokens) {
		return false
	}
	for i, t := range prefix {
		if tokens[i] != t {
			return false
		}
	}
	return true
}

var segmentSplit = regexp.MustCompile(`&&|\|\||;|\||&|\n`)
var assignment = regexp.MustCompile(`^[A-Za-z_]\w*=`)

// isDenied: deny is fail-closed. Every operator-separated segment, shell
// wrapper unwrapped and leading NAME=value assignments dropped, is checked,
// so a denied command wrapped, chained or prefixed with env still matches.
// A miss still faces the sandbox and the human prompt.
func isDenied(command string, deny [][]string) bool {
	command = strings.TrimSpace(command)
	if len(deny) == 0 || command == "" {
		return false
	}
	script := command
	if inner, ok := unwrapShellScript(command); ok {
		script = inner
	}
	for _, segment := range segmentSplit.Split(script, -1) {
		segment = strings.TrimSpace(segment)
		if segment == "" {
			continue
		}
		tokens := strings.Fields(segment)
		i := 0
		for i < len(tokens) && assignment.MatchString(tokens[i]) {
			i++
		}
		for _, p := range deny {
			if isTokenPrefix(p, tokens[i:]) {
				return true
			}
		}
	}
	return false
}

var shellWrapper = regexp.MustCompile(`^(?:sh|bash|/bin/sh|/bin/bash)\s+(?:-c|-lc|-l\s+-c)\s+(.+)$`)

// unwrapShellScript is the script of a non-interactive shell wrapper.
func unwrapShellScript(command string) (string, bool) {
	m := shellWrapper.FindStringSubmatch(command)
	if m == nil {
		return "", false
	}
	arg := strings.TrimSpace(m[1])
	if q := arg[0]; q == '\'' || q == '"' {
		if len(arg) >= 2 && arg[len(arg)-1] == q {
			return arg[1 : len(arg)-1], true
		}
		return "", false
	}
	if strings.ContainsAny(arg, " \t\n\r\f\v") {
		return "", false
	}
	return arg, true
}

func promptFor(params protocol.CommandExecutionRequestApprovalParams) string {
	where, reason := "", ""
	if params.Cwd != nil && *params.Cwd != "" {
		where = " in " + *params.Cwd
	}
	command := "(a command)"
	if params.Command != nil {
		command = *params.Command
	}
	if params.Reason != nil && *params.Reason != "" {
		reason = " — " + *params.Reason
	}
	return "Codex wants to run `" + command + "`" + where + reason
}

// availableDecisions are the string decisions Codex offered, in its order;
// the amendment variants are objects and are not offered to the human.
func availableDecisions(params protocol.CommandExecutionRequestApprovalParams) []string {
	var offered []string
	for _, d := range params.AvailableDecisions {
		if d.Value != "" {
			offered = append(offered, d.Value)
		}
	}
	if len(offered) == 0 {
		return []string{"accept", "acceptForSession", "decline"}
	}
	return offered
}

// apply routes one notification to its run and folds in its event or status.
func (p *Pump) apply(n codex.Notification) {
	// Rate limits are account-wide, with no threadId: folded into the
	// registry and every live run woken.
	if n.Method == "account/rateLimits/updated" {
		var params struct {
			RateLimits rateLimits `json:"rateLimits"`
		}
		if protocol.Decode(n.Params, &params) == nil {
			p.Runs.MergeAccountLimits(LimitsFrom(params.RateLimits))
		}
		for _, h := range p.Runs.Handles() {
			p.Runs.Bump(h)
		}
		return
	}

	handle := p.runFor(n)
	if handle == "" {
		return
	}
	when := at(n)
	changed := false
	terminal := n.Method == "turn/completed" || n.Method == "error"

	var event *Event
	if !terminal {
		if e, ok := EventOf(n); ok {
			event = &e
		}
	}
	text, phase, isMessage := agentMessageOf(n)

	var tokenUsage *protocol.ThreadTokenUsageUpdatedNotification
	if n.Method == "thread/tokenUsage/updated" {
		tokenUsage = &protocol.ThreadTokenUsageUpdatedNotification{}
		_ = protocol.Decode(n.Params, tokenUsage)
	}
	var started protocol.TurnStartedNotification
	if n.Method == "turn/started" {
		_ = protocol.Decode(n.Params, &started)
	}
	var completed protocol.TurnCompletedNotification
	if n.Method == "turn/completed" {
		_ = protocol.Decode(n.Params, &completed)
	}
	var failure protocol.ErrorNotification
	if n.Method == "error" {
		_ = protocol.Decode(n.Params, &failure)
	}

	p.Runs.Update(handle, func(r *Record) {
		if tokenUsage != nil {
			if ctx, ok := ctxPercentOf(tokenUsage.TokenUsage); ok {
				r.Ctx = &ctx
				changed = true
			}
		}
		if event != nil {
			r.Events = append(r.Events, *event)
			changed = true
		}
		if isMessage {
			t := text
			r.Events = append(r.Events, Event{Kind: "message", At: when, Text: &t, Phase: phase})
			changed = true
		}
		if n.Method == "turn/started" {
			// The live turn id, fresh on every turn, so cancel and steer
			// always name the active one.
			r.TurnID = started.Turn.Id
			changed = true
		}
		switch n.Method {
		case "turn/completed":
			turn := completed.Turn
			if turn.Status == "failed" {
				r.Status = Failed
				e := Event{Kind: "error", At: when, Message: "turn failed"}
				if turn.Error != nil {
					e.Message = turn.Error.Message
					if turn.Error.AdditionalDetails != nil {
						e.Details = *turn.Error.AdditionalDetails
					}
				}
				r.Events = append(r.Events, e)
			} else {
				// completed or interrupted (a cancel) both settle the run.
				r.Status = Done
				result := Event{Kind: "result", At: when, Status: string(turn.Status), DurationMs: turn.DurationMs}
				final, ok := lastAgentMessage(turn)
				last := len(r.Events) - 1
				if ok && final != "" && last >= 0 && r.Events[last].Kind == "message" && str(r.Events[last].Text) == final {
					// The final message streamed as a message this same
					// poll: it becomes the result, not delivered twice.
					result.At = r.Events[last].At
					result.Text = &final
					r.Events[last] = result
				} else {
					if ok && final != "" {
						result.Text = &final
					}
					r.Events = append(r.Events, result)
				}
			}
			changed = true
		case "error":
			r.Status = Failed
			e := Event{Kind: "error", At: when, Message: failure.Error.Message}
			if failure.Error.AdditionalDetails != nil {
				e.Details = *failure.Error.AdditionalDetails
			}
			r.Events = append(r.Events, e)
			changed = true
		}
	})
	if changed {
		p.Runs.Bump(handle)
	}
}

// runFor is the run a notification belongs to: its threadId's, or, with no
// threadId and exactly one live run, that one.
func (p *Pump) runFor(n codex.Notification) string {
	if id := ThreadIDOf(n); id != "" {
		if _, ok := p.Runs.Status(id); ok {
			return id
		}
		return ""
	}
	handles := p.Runs.Handles()
	if len(handles) == 1 {
		return handles[0]
	}
	return ""
}

// ctxPercentOf is the thread's context occupancy as a percentage of the
// model's window, unknown when the window is.
func ctxPercentOf(u protocol.ThreadTokenUsage) (int, bool) {
	if u.ModelContextWindow == nil || *u.ModelContextWindow <= 0 {
		return 0, false
	}
	return round(float64(u.Total.TotalTokens) / float64(*u.ModelContextWindow) * 100), true
}

// agentMessageOf is Codex's own words from a completing agentMessage item,
// its back-channel to the driving agent.
func agentMessageOf(n codex.Notification) (string, string, bool) {
	if n.Method != "item/completed" {
		return "", "", false
	}
	var params protocol.ItemCompletedNotification
	if protocol.Decode(n.Params, &params) != nil {
		return "", "", false
	}
	m := params.Item.AgentMessage
	if m == nil || m.Text == "" {
		return "", "", false
	}
	phase := ""
	if m.Phase != nil {
		phase = string(*m.Phase)
	}
	return m.Text, phase, true
}

// lastAgentMessage is the final agent message of a turn, its result.
func lastAgentMessage(turn protocol.Turn) (string, bool) {
	for i := len(turn.Items) - 1; i >= 0; i-- {
		if m := turn.Items[i].AgentMessage; m != nil {
			return m.Text, true
		}
	}
	return "", false
}

// ErrNoElicitation is returned by an Elicitation that cannot ask.
var ErrNoElicitation = errors.New("the client does not support elicitation")
