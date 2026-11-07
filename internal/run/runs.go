package run

// The run registry and the logic of the MCP tools.
//
// Start (codex_run) returns a handle as soon as thread/start has answered,
// and kicks the turn off in the background: a tool call that blocked on the
// whole turn would hit Claude Code's ~120s ceiling, get backgrounded and
// abandon any pending elicitation, the hang this project exists to fix.
// Status touches no I/O: it reads whatever the pump last wrote.
//
// Every run gets a fresh app-server (per-run spawn, docs/DESIGN.md), its
// config compiled from the settings read at that moment. Codex is not
// touched until the first run, so the MCP server answers initialize and
// tools/list whatever state codex is in, and a broken codex fails only a
// codex_run call.

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"sort"
	"sync"
	"time"

	"github.com/danielbodart/dragoman/internal/codex"
	"github.com/danielbodart/dragoman/internal/posture"
	"github.com/danielbodart/dragoman/internal/protocol"
	"github.com/danielbodart/gokit/logx"
)

// Provisioned is a fresh app-server for one run, and the teardown to run
// once the run settles (close it, remove its home).
type Provisioned struct {
	Conn    codex.Conn
	Cleanup func()
}

// Provision compiles nothing: it writes the policy's home and spawns codex.
type Provision func(ctx context.Context, policy posture.Policy) (Provisioned, error)

// Runs is the registry: keyed by thread id, which is also the handle.
type Runs struct {
	provision Provision
	onConn    func(codex.Conn)
	now       func() int64
	settings  func() posture.Effective
	log       logx.Logger

	mu          sync.Mutex
	runs        map[string]*Record
	order       []string
	revisions   map[string]int
	wake        map[string]chan struct{}
	provisioned map[string]Provisioned
	account     Usage
	warned      map[string]bool
}

// New builds a registry. onConn wires the pump onto each new connection;
// settings reads Claude's settings at the moment a run is provisioned.
func New(provision Provision, onConn func(codex.Conn), now func() int64, settings func() posture.Effective, log logx.Logger) *Runs {
	if onConn == nil {
		onConn = func(codex.Conn) {}
	}
	if now == nil {
		now = func() int64 { return time.Now().UnixMilli() }
	}
	if log == nil {
		log = logx.Discard
	}
	return &Runs{
		provision: provision, onConn: onConn, now: now, settings: settings, log: log,
		runs: map[string]*Record{}, revisions: map[string]int{}, wake: map[string]chan struct{}{},
		provisioned: map[string]Provisioned{}, warned: map[string]bool{},
	}
}

// Now is the registry's clock, in milliseconds.
func (r *Runs) Now() int64 { return r.now() }

// CloseAll tears down every live app-server, for shutdown.
func (r *Runs) CloseAll() {
	r.mu.Lock()
	handles := make([]string, 0, len(r.provisioned))
	for h := range r.provisioned {
		handles = append(handles, h)
	}
	r.mu.Unlock()
	for _, h := range handles {
		r.dispose(h)
	}
}

// dispose tears down a run's app-server. Idempotent, and best-effort: a
// failed cleanup must never break status or bump.
func (r *Runs) dispose(handle string) {
	r.mu.Lock()
	p, ok := r.provisioned[handle]
	delete(r.provisioned, handle)
	r.mu.Unlock()
	if !ok || p.Cleanup == nil {
		return
	}
	defer func() { _ = recover() }()
	p.Cleanup()
}

type mirrored struct {
	settings    posture.Effective
	policy      posture.Policy
	provisioned Provisioned
}

// provisionMirror compiles Claude's live settings into a fresh policy and
// provisions an app-server for it: the shared opening of start, review and
// continue.
func (r *Runs) provisionMirror(ctx context.Context, posturePassed string) (mirrored, error) {
	settings := r.settings()
	mode, unknown := posture.ResolveMode(settings, posturePassed)
	if unknown != "" {
		r.mu.Lock()
		first := !r.warned[unknown]
		r.warned[unknown] = true
		r.mu.Unlock()
		if first {
			r.log.Error(fmt.Sprintf("Dragoman: permission mode %q is not one it knows; running Codex as %q, where every write asks", unknown, mode))
		}
	}
	policy := posture.Mirror(settings, mode)
	p, err := r.provision(ctx, policy)
	if err != nil {
		return mirrored{}, err
	}
	r.onConn(p.Conn)
	r.seedAccountLimits(p.Conn)
	return mirrored{settings: settings, policy: policy, provisioned: p}, nil
}

// seedAccountLimits reads the rate-limit windows once at connect, so the
// first diagnostics already has them. Best-effort and never waited on.
func (r *Runs) seedAccountLimits(conn codex.Conn) {
	go func() {
		raw, err := conn.Request(context.Background(), "account/rateLimits/read", nil)
		if err != nil {
			return
		}
		var resp struct {
			RateLimits *rateLimits `json:"rateLimits"`
		}
		if protocol.Decode(raw, &resp) != nil || resp.RateLimits == nil {
			return
		}
		r.MergeAccountLimits(LimitsFrom(*resp.RateLimits))
		for _, h := range r.Handles() {
			r.Bump(h)
		}
	}()
}

// threadParams is what thread/start and thread/resume share: the profile and
// writable roots, or the danger sandbox for bypassPermissions (sandbox and a
// profile are mutually exclusive).
type threadParams struct {
	Cwd                   string                      `json:"cwd"`
	ApprovalPolicy        protocol.AskForApproval     `json:"approvalPolicy"`
	ApprovalsReviewer     *protocol.ApprovalsReviewer `json:"approvalsReviewer,omitempty"`
	Config                map[string]any              `json:"config"`
	Permissions           *string                     `json:"permissions,omitempty"`
	RuntimeWorkspaceRoots []protocol.AbsolutePathBuf  `json:"runtimeWorkspaceRoots,omitempty"`
	Sandbox               *protocol.SandboxMode       `json:"sandbox,omitempty"`
}

func mirrorParams(policy posture.Policy, settings posture.Effective, cwd string) threadParams {
	p := threadParams{
		Cwd:            cwd,
		ApprovalPolicy: policy.ApprovalPolicy,
		// Codex's native concise mode: a scalar config override both
		// thread/start and thread/resume take.
		Config: map[string]any{"model_verbosity": "low"},
	}
	if policy.ApprovalsReviewer != "" {
		reviewer := policy.ApprovalsReviewer
		p.ApprovalsReviewer = &reviewer
	}
	if policy.Profile != nil {
		id := policy.Profile.ID
		p.Permissions = &id
		p.RuntimeWorkspaceRoots = append([]string{cwd}, settings.AdditionalDirectories...)
	} else {
		danger := protocol.SandboxMode("danger-full-access")
		p.Sandbox = &danger
	}
	return p
}

// threadReply is what Dragoman reads of thread/start's and thread/resume's
// results: the thread id, and the model and effort plan mode echoes back.
type threadReply struct {
	Thread struct {
		ID string `json:"id"`
	} `json:"thread"`
	Model           string          `json:"model"`
	ReasoningEffort json.RawMessage `json:"reasoningEffort"`
}

func decodeThread(method string, raw json.RawMessage) (threadReply, error) {
	var t threadReply
	if err := protocol.Decode(raw, &t); err != nil {
		return t, fmt.Errorf("%s: %w", method, err)
	}
	if t.Thread.ID == "" {
		return t, fmt.Errorf("%s answered without a thread id: %s", method, truncate(raw))
	}
	return t, nil
}

// Start starts a run and returns its handle without waiting for it.
func (r *Runs) Start(ctx context.Context, prompt, cwd, posturePassed string) (string, error) {
	m, err := r.provisionMirror(ctx, posturePassed)
	if err != nil {
		return "", err
	}
	conn := m.provisioned.Conn
	raw, err := conn.Request(ctx, "thread/start", mirrorParams(m.policy, m.settings, cwd))
	var thread threadReply
	if err == nil {
		thread, err = decodeThread("thread/start", raw)
	}
	if err != nil {
		cleanup(m.provisioned)
		return "", err
	}
	handle := thread.Thread.ID
	r.register(handle, cwd, m.policy, m.provisioned)
	r.kickTurn(handle, conn, m.policy, prompt, thread.Model, thread.ReasoningEffort)
	return handle, nil
}

// Review starts Codex's dedicated review pass over target, provisioned like
// a run; review/start replaces turn/start. Delivery is inline, so the review
// turn stays on this handle, where the pump routes its notifications.
func (r *Runs) Review(ctx context.Context, cwd string, target protocol.ReviewTarget, posturePassed string) (string, error) {
	m, err := r.provisionMirror(ctx, posturePassed)
	if err != nil {
		return "", err
	}
	conn := m.provisioned.Conn
	raw, err := conn.Request(ctx, "thread/start", mirrorParams(m.policy, m.settings, cwd))
	var thread threadReply
	if err == nil {
		thread, err = decodeThread("thread/start", raw)
	}
	if err != nil {
		cleanup(m.provisioned)
		return "", err
	}
	handle := thread.Thread.ID
	r.register(handle, cwd, m.policy, m.provisioned)
	r.kickReview(handle, conn, target)
	return handle, nil
}

// ContinueRun continues a settled thread with a new prompt, provisioned
// exactly like a new run, so it runs under the mode in force now, then
// thread/resume by id and a new turn. The handle is unchanged.
func (r *Runs) ContinueRun(ctx context.Context, handle, prompt, posturePassed string) (string, error) {
	r.mu.Lock()
	prior, ok := r.runs[handle]
	_, live := r.provisioned[handle]
	cwd := ""
	if ok {
		cwd = prior.Cwd
	}
	r.mu.Unlock()
	switch {
	case !ok:
		return fmt.Sprintf("No Codex task with handle %q.", handle), nil
	case live:
		// A live run still owns its app-server; resuming would fork it.
		return fmt.Sprintf("Codex task %q is still running — steer it instead of continuing.", handle), nil
	case cwd == "":
		return fmt.Sprintf("Codex task %q cannot be continued (no recorded working directory).", handle), nil
	}
	m, err := r.provisionMirror(ctx, posturePassed)
	if err != nil {
		return "", err
	}
	conn := m.provisioned.Conn
	params := struct {
		ThreadID string `json:"threadId"`
		threadParams
	}{handle, mirrorParams(m.policy, m.settings, cwd)}
	raw, err := conn.Request(ctx, "thread/resume", params)
	if err != nil {
		cleanup(m.provisioned)
		return "", err
	}
	var resumed threadReply
	_ = protocol.Decode(raw, &resumed)
	r.register(handle, cwd, m.policy, m.provisioned)
	r.kickTurn(handle, conn, m.policy, prompt, resumed.Model, resumed.ReasoningEffort)
	return fmt.Sprintf("Continuing Codex task %q. Poll codex_status with the same handle.", handle), nil
}

// Cancel interrupts a run's active turn. It returns once Codex has the
// request; the pump folds the interrupted turn into the terminal state.
func (r *Runs) Cancel(ctx context.Context, handle string) (string, error) {
	conn, turn, msg := r.active(handle, "cancel")
	if msg != "" {
		return msg, nil
	}
	if _, err := conn.Request(ctx, "turn/interrupt", protocol.TurnInterruptParams{ThreadId: handle, TurnId: turn}); err != nil {
		return "", err
	}
	return fmt.Sprintf("Requested cancel of Codex task %q. Poll codex_status to confirm it stopped.", handle), nil
}

// Steer injects guidance into the in-flight turn. expectedTurnId is a hard
// precondition on the server, so a rejection is expected, and reported as a
// line the caller can act on, never an error.
func (r *Runs) Steer(ctx context.Context, handle, text string) (string, error) {
	conn, turn, msg := r.active(handle, "steer")
	if msg != "" {
		return msg, nil
	}
	raw, err := conn.Request(ctx, "turn/steer", protocol.TurnSteerParams{
		ThreadId:       handle,
		Input:          []protocol.UserInput{textInput(text)},
		ExpectedTurnId: turn,
	})
	if err != nil {
		return fmt.Sprintf("Could not steer Codex task %q: %s. It may have moved past the turn — poll codex_status.", handle, err), nil
	}
	var resp protocol.TurnSteerResponse
	_ = protocol.Decode(raw, &resp)
	r.Update(handle, func(rec *Record) {
		if resp.TurnId != "" {
			rec.TurnID = resp.TurnId
		}
	})
	r.Bump(handle)
	return fmt.Sprintf("Steered Codex task %q. Poll codex_status to see it take effect.", handle), nil
}

// active is a live run's conn and turn, or the line saying why there is none.
func (r *Runs) active(handle, verb string) (codex.Conn, string, string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	rec, ok := r.runs[handle]
	if !ok {
		return nil, "", fmt.Sprintf("No Codex task with handle %q.", handle)
	}
	if rec.Status.terminal() {
		return nil, "", fmt.Sprintf("Codex task %q has already finished — nothing to %s.", handle, verb)
	}
	p, live := r.provisioned[handle]
	if !live || rec.TurnID == "" {
		return nil, "", fmt.Sprintf("Codex task %q has no active turn to %s.", handle, verb)
	}
	return p.Conn, rec.TurnID, ""
}

func textInput(text string) protocol.UserInput {
	return protocol.UserInput{Text: &protocol.TextUserInput{Type: "text", Text: text, TextElements: []protocol.TextElement{}}}
}

// register records a freshly provisioned run, new or continued. A
// continuation resets the record, so the stale turn id is cleared.
func (r *Runs) register(handle, cwd string, policy posture.Policy, p Provisioned) {
	r.mu.Lock()
	r.provisioned[handle] = p
	if _, seen := r.runs[handle]; !seen {
		r.order = append(r.order, handle)
	}
	r.runs[handle] = &Record{
		Handle: handle, Cwd: cwd, Status: Starting, Events: []Event{},
		ExecpolicyAmendments: policy.ExecpolicyAmendments, DenyPrefixes: policy.DenyPrefixes,
		CommandFallback: policy.CommandFallback, FileChange: policy.FileChange,
	}
	r.mu.Unlock()
	r.Bump(handle)
}

// turnStart is turn/start's params as Dragoman sends them.
type turnStart struct {
	ThreadID          string                      `json:"threadId"`
	Input             []protocol.UserInput        `json:"input"`
	ApprovalPolicy    protocol.AskForApproval     `json:"approvalPolicy"`
	ApprovalsReviewer *protocol.ApprovalsReviewer `json:"approvalsReviewer,omitempty"`
	Permissions       *string                     `json:"permissions,omitempty"`
	CollaborationMode *collaborationMode          `json:"collaborationMode,omitempty"`
}

// collaborationMode is Codex's native plan mode. Its settings.model is
// required and overrides the model, so it echoes back the one Codex resolved
// for the thread; developer_instructions null means Codex's built-in plan
// instructions. Both nulls are sent, as the TypeScript sent them.
type collaborationMode struct {
	Mode     protocol.ModeKind `json:"mode"`
	Settings struct {
		Model                 string          `json:"model"`
		ReasoningEffort       json.RawMessage `json:"reasoning_effort"`
		DeveloperInstructions *string         `json:"developer_instructions"`
	} `json:"settings"`
}

// kickTurn starts a turn in the background; the pump drives it from the
// notifications. A failure to start it is recorded on the run, since a
// handle has already been promised. The active turn id is taken from the
// reply, so a cancel or steer arriving before the first turn/started
// already has its precondition.
func (r *Runs) kickTurn(handle string, conn codex.Conn, policy posture.Policy, prompt, model string, effort json.RawMessage) {
	params := turnStart{ThreadID: handle, Input: []protocol.UserInput{textInput(prompt)}, ApprovalPolicy: policy.ApprovalPolicy}
	if policy.ApprovalsReviewer != "" {
		reviewer := policy.ApprovalsReviewer
		params.ApprovalsReviewer = &reviewer
	}
	if policy.Profile != nil {
		id := policy.Profile.ID
		params.Permissions = &id
	}
	if policy.CollaborationMode != "" {
		cm := &collaborationMode{Mode: policy.CollaborationMode}
		cm.Settings.Model = model
		cm.Settings.ReasoningEffort = effort
		if len(effort) == 0 {
			cm.Settings.ReasoningEffort = json.RawMessage("null")
		}
		params.CollaborationMode = cm
	}
	go r.kick(handle, conn, "turn/start", params, "failed to start turn")
}

// kickReview starts a review turn in the background, as kickTurn does.
func (r *Runs) kickReview(handle string, conn codex.Conn, target protocol.ReviewTarget) {
	inline := protocol.ReviewDelivery("inline")
	go r.kick(handle, conn, "review/start", protocol.ReviewStartParams{ThreadId: handle, Target: target, Delivery: &inline}, "failed to start review")
}

func (r *Runs) kick(handle string, conn codex.Conn, method string, params any, failure string) {
	raw, err := conn.Request(context.Background(), method, params)
	if err != nil {
		r.fail(handle, failure+": "+err.Error())
		return
	}
	var resp struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	_ = protocol.Decode(raw, &resp)
	r.Update(handle, func(rec *Record) {
		if rec.Status == Starting {
			rec.Status = Running
		}
		if resp.Turn.ID != "" {
			rec.TurnID = resp.Turn.ID
		}
	})
	r.Bump(handle)
}

// fail records a failure to start, but only on a run still in its opening
// phase: a late rejection must not stomp a run the pump has already moved on.
func (r *Runs) fail(handle, message string) {
	changed := false
	r.Update(handle, func(rec *Record) {
		if rec.Status == Starting || rec.Status == Running {
			rec.Status = Failed
			rec.Events = append(rec.Events, Event{Kind: "error", At: r.now(), Message: message})
			changed = true
		}
	})
	if changed {
		r.Bump(handle)
	}
}

// Status is a copy of a run's current state; no I/O.
func (r *Runs) Status(handle string) (Record, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	rec, ok := r.runs[handle]
	if !ok {
		return Record{}, false
	}
	c := *rec
	c.Events = slices.Clone(rec.Events)
	return c, true
}

// Update runs fn on a run's live record under the registry's lock: the one
// way the pump mutates a run. It says whether the run exists. The caller
// bumps once it has finished, so a burst folds into one wake.
func (r *Runs) Update(handle string, fn func(*Record)) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	rec, ok := r.runs[handle]
	if ok {
		fn(rec)
	}
	return ok
}

// Append adds one event to a run's timeline. Unknown handle, no-op.
func (r *Runs) Append(handle string, e Event) {
	r.Update(handle, func(rec *Record) { rec.Events = append(rec.Events, e) })
}

// HasPending says whether a run has events not yet drained.
func (r *Runs) HasPending(handle string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	rec, ok := r.runs[handle]
	return ok && len(rec.Events) > 0
}

// Drain removes and returns a run's undelivered events, oldest first. Each
// is handed out exactly once.
func (r *Runs) Drain(handle string) []Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	rec, ok := r.runs[handle]
	if !ok || len(rec.Events) == 0 {
		return []Event{}
	}
	drained := rec.Events
	rec.Events = []Event{}
	return drained
}

// Handles is every run the registry holds, in the order first seen.
func (r *Runs) Handles() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.order)
}

// MergeAccountLimits merges a sparse rate-limit update: a window present
// overwrites, one absent leaves the last value standing.
func (r *Runs) MergeAccountLimits(u Usage) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if u.FiveHour != nil {
		r.account.FiveHour = u.FiveHour
	}
	if u.SevenDay != nil {
		r.account.SevenDay = u.SevenDay
	}
}

// AccountLimits is the account-wide windows seen so far.
func (r *Runs) AccountLimits() Usage {
	r.mu.Lock()
	defer r.mu.Unlock()
	return Usage{FiveHour: r.account.FiveHour, SevenDay: r.account.SevenDay}
}

// Bump advances a run's revision and wakes every long-poll on it. A settled
// run's app-server has done its job and is torn down; its record stays, so
// codex_status still reports the final state.
func (r *Runs) Bump(handle string) {
	r.mu.Lock()
	r.revisions[handle]++
	if ch, ok := r.wake[handle]; ok {
		close(ch)
		delete(r.wake, handle)
	}
	rec, ok := r.runs[handle]
	settled := ok && rec.Status.terminal()
	r.mu.Unlock()
	if settled {
		r.dispose(handle)
	}
}

// Revision is a run's revision, 0 until its first change.
func (r *Runs) Revision(handle string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.revisions[handle]
}

// WaitForUpdate returns as soon as the run advances past since (or is
// terminal), else when timeout elapses, with the latest state and revision
// either way. It makes no calls while a run sits quiet.
func (r *Runs) WaitForUpdate(handle string, since int, timeout time.Duration) (Record, bool, int) {
	return r.waitForUpdate(context.Background(), handle, since, timeout)
}

func (r *Runs) waitForUpdate(ctx context.Context, handle string, since int, timeout time.Duration) (Record, bool, int) {
	r.mu.Lock()
	rec, ok := r.runs[handle]
	if r.revisions[handle] > since || (ok && rec.Status.terminal()) {
		r.mu.Unlock()
		snap, ok := r.Status(handle)
		return snap, ok, r.Revision(handle)
	}
	ch, exists := r.wake[handle]
	if !exists {
		ch = make(chan struct{})
		r.wake[handle] = ch
	}
	r.mu.Unlock()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-ch:
	case <-timer.C:
	case <-ctx.Done():
	}
	snap, ok := r.Status(handle)
	return snap, ok, r.Revision(handle)
}

// WaitForEvents parks until the run has an undelivered event or is terminal,
// or timeout elapses: the wait behind codex_status. A bump that appends no
// event (telemetry, a turn id) does not end it: the caller would only spend
// a model turn reading an empty reply. It returns early when ctx is done.
func (r *Runs) WaitForEvents(ctx context.Context, handle string, timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for {
		rec, ok := r.Status(handle)
		if !ok || len(rec.Events) > 0 || rec.Status.terminal() {
			return
		}
		remaining := time.Until(deadline)
		if remaining <= 0 || ctx.Err() != nil {
			return
		}
		r.waitForUpdate(ctx, handle, r.Revision(handle), remaining)
	}
}

// rateLimits is what Dragoman reads of a rate-limit snapshot, as floats, so
// a fractional percentage still decodes.
type rateLimits struct {
	Primary   *window `json:"primary"`
	Secondary *window `json:"secondary"`
}

type window struct {
	UsedPercent        float64  `json:"usedPercent"`
	WindowDurationMins *float64 `json:"windowDurationMins"`
}

// LimitsFrom is a snapshot's two windows as percentages, keyed by duration:
// the shorter is 5h, the longer 7d, whichever position Codex gave them.
func LimitsFrom(s rateLimits) Usage {
	var windows []window
	for _, w := range []*window{s.Primary, s.Secondary} {
		if w != nil {
			windows = append(windows, *w)
		}
	}
	mins := func(w window) float64 {
		if w.WindowDurationMins == nil {
			return 0
		}
		return *w.WindowDurationMins
	}
	sort.SliceStable(windows, func(i, j int) bool { return mins(windows[i]) < mins(windows[j]) })
	var u Usage
	if len(windows) > 0 {
		v := round(windows[0].UsedPercent)
		u.FiveHour = &v
	}
	if len(windows) > 1 {
		v := round(windows[1].UsedPercent)
		u.SevenDay = &v
	}
	return u
}

// round is JavaScript's Math.round.
func round(x float64) int { return int(math.Floor(x + 0.5)) }

func cleanup(p Provisioned) {
	if p.Cleanup != nil {
		p.Cleanup()
	}
}

func truncate(raw []byte) string {
	if len(raw) > 200 {
		return string(raw[:200]) + "…"
	}
	return string(raw)
}
