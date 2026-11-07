package posture

import (
	"path/filepath"
	"regexp"
	"strings"

	"github.com/danielbodart/dragoman/internal/codexhome"
	"github.com/danielbodart/dragoman/internal/protocol"
)

// Mode is a Claude permission mode (code.claude.com/docs/en/permission-modes).
// Manual mode's config value is `default`; the CLI also accepts `manual` for
// the same mode, and both map identically here.
type Mode string

const (
	Plan              Mode = "plan"
	Default           Mode = "default"
	Manual            Mode = "manual"
	AcceptEdits       Mode = "acceptEdits"
	Auto              Mode = "auto"
	DontAsk           Mode = "dontAsk"
	BypassPermissions Mode = "bypassPermissions"
)

// SafeDefault is the mode when none is known: `default`, Manual mode, Claude's
// own built-in default. Reads run; everything else asks.
const SafeDefault = Default

// Fallback is what to do with an approval the rules don't settle.
type Fallback string

const (
	Elicit  Fallback = "elicit"
	Decline Fallback = "decline"
	Accept  Fallback = "accept"
)

// Policy is the Codex policy a thread and its turns get, mirroring Claude.
type Policy struct {
	ApprovalPolicy protocol.AskForApproval
	// ApprovalsReviewer is who adjudicates escalations; "" for none. It is
	// set to `user` explicitly to reach the human: left unset, Codex
	// self-approves through its internal review, not the human.
	ApprovalsReviewer protocol.ApprovalsReviewer
	// CommandFallback is for a command approval the allow/deny prefixes
	// don't settle: Elicit asks the human, Decline refuses without asking.
	CommandFallback Fallback
	// FileChange is for a file-edit approval: Elicit, Accept or Decline.
	FileChange Fallback
	// ExecpolicyAmendments are command-token prefixes from Claude's allow
	// Bash rules (and curl/wget for a WebFetch(domain:) rule).
	ExecpolicyAmendments [][]string
	// DenyPrefixes are command-token prefixes from Claude's deny Bash rules.
	DenyPrefixes [][]string
	// Profile is the permission profile the thread selects; nil for
	// bypassPermissions, which uses the danger-full-access sandbox enum,
	// since :danger-full-access is not an extendable profile base.
	Profile *codexhome.Profile
	// CollaborationMode is Codex's native collaboration mode: `plan` for
	// Claude's plan mode, else "".
	CollaborationMode protocol.ModeKind
}

// ProfileIDForBase is the profile id for a base scope: :workspace is
// dragoman-workspace.
func ProfileIDForBase(base string) string {
	return "dragoman-" + strings.TrimPrefix(base, ":")
}

// baseFor is the profile base: :workspace for the modes that auto-allow
// writes, :read-only for those that ask or refuse, "" (no profile, so
// danger-full-access) for bypassPermissions. Never more than Claude's mode
// would grant.
func baseFor(mode Mode) string {
	switch mode {
	case BypassPermissions:
		return ""
	case AcceptEdits, Auto:
		return ":workspace"
	}
	return ":read-only"
}

// ProfileFor is the one profile a thread selects, or nil for
// danger-full-access.
func ProfileFor(s Effective, mode Mode) *codexhome.Profile {
	base := baseFor(mode)
	if base == "" {
		return nil
	}
	network := networkFor(s)
	files := FilesystemFor(s)
	return &codexhome.Profile{ID: ProfileIDForBase(base), Base: base, Network: &network, Filesystem: &files}
}

// networkFor is Claude's network posture as profile rules: allowedDomains and
// WebFetch(domain:) allows become allows, deniedDomains denies.
func networkFor(s Effective) codexhome.Network {
	domains := []codexhome.Entry{}
	for _, h := range s.AllowedDomains {
		domains = append(domains, codexhome.Entry{Key: h, Value: "allow"})
	}
	for _, rule := range s.Allow {
		if h := webFetchDomain(rule); h != "" {
			domains = append(domains, codexhome.Entry{Key: h, Value: "allow"})
		}
	}
	for _, h := range s.DeniedDomains {
		domains = append(domains, codexhome.Entry{Key: h, Value: "deny"})
	}
	return codexhome.Network{Enabled: networkEnabled(s), Domains: domains}
}

var webFetchRule = regexp.MustCompile(`^WebFetch\(domain:([^)]+)\)$`)

func webFetchDomain(rule string) string {
	m := webFetchRule.FindStringSubmatch(strings.TrimSpace(rule))
	if m == nil {
		return ""
	}
	return strings.TrimSpace(m[1])
}

func isWebFetchDomainAllow(rule string) bool {
	return strings.HasPrefix(strings.TrimSpace(rule), "WebFetch(domain:")
}

// FilesystemFor maps Claude's four lists to access levels by what they mean:
// denyRead deny, denyWrite read (still readable, not deny), allowWrite write,
// allowRead read. A path in several lists takes the first in that order, the
// most restrictive. Absolute paths anchor to the top-level table, the rest
// under :workspace_roots.
func FilesystemFor(s Effective) codexhome.Filesystem {
	var order []string
	chosen := map[string]string{}
	claim := func(paths []string, access string) {
		for _, p := range paths {
			key := strings.TrimSpace(p)
			if key == "" {
				continue
			}
			if _, ok := chosen[key]; !ok {
				chosen[key] = access
				order = append(order, key)
			}
		}
	}
	claim(s.DenyRead, "deny")
	claim(s.DenyWrite, "read")
	claim(s.AllowWrite, "write")
	claim(s.AllowRead, "read")
	fs := codexhome.Filesystem{Paths: []codexhome.Entry{}, WorkspaceRoots: []codexhome.Entry{}}
	for _, p := range order {
		e := codexhome.Entry{Key: p, Value: chosen[p]}
		if filepath.IsAbs(p) {
			fs.Paths = append(fs.Paths, e)
		} else {
			fs.WorkspaceRoots = append(fs.WorkspaceRoots, e)
		}
	}
	return fs
}

// Mirror maps an already-resolved mode onto a Codex policy.
func Mirror(s Effective, mode Mode) Policy {
	p := Policy{
		ApprovalPolicy:       approvalFor(mode),
		ApprovalsReviewer:    reviewerFor(mode),
		CommandFallback:      commandFallbackFor(mode),
		FileChange:           fileChangeFor(mode),
		ExecpolicyAmendments: fetchAllows(s),
		DenyPrefixes:         bashPrefixes(s.Deny),
		Profile:              ProfileFor(s, mode),
	}
	if mode == Plan {
		p.CollaborationMode = "plan"
	}
	return p
}

// commandFallbackFor: dontAsk and plan refuse an unmatched command without
// asking; the rest ask the human.
func commandFallbackFor(mode Mode) Fallback {
	if mode == DontAsk || mode == Plan {
		return Decline
	}
	return Elicit
}

// fileChangeFor: dontAsk and plan refuse; the rest ask. acceptEdits asks too:
// under its granular policy an in-workspace edit auto-runs with no approval,
// so the only one it sees is an escape, which Claude prompts for.
func fileChangeFor(mode Mode) Fallback {
	if mode == DontAsk || mode == Plan {
		return Decline
	}
	return Elicit
}

// ResolveMode picks the mode from the three tiers: the live posture the hook
// recorded, else the static defaultMode, else the safe default. A value it
// does not recognise degrades to the safe default rather than erroring, and
// is returned so the caller can warn once: a new Claude mode should degrade,
// not break Codex.
func ResolveMode(s Effective, posture string) (Mode, string) {
	if m, ok := asMode(posture); ok {
		return m, ""
	}
	unknown := ""
	if posture != "" {
		unknown = posture
	}
	if s.DefaultMode != nil {
		if m, ok := asMode(*s.DefaultMode); ok {
			return m, unknown
		}
		if unknown == "" && *s.DefaultMode != "" {
			unknown = *s.DefaultMode
		}
	}
	return SafeDefault, unknown
}

func asMode(v string) (Mode, bool) {
	switch m := Mode(v); m {
	case Plan, Default, Manual, AcceptEdits, Auto, DontAsk, BypassPermissions:
		return m, true
	}
	return "", false
}

// granular raises sandbox escapes for review; `on-request` leaves escalation
// to the model and does not turn a sandbox denial into an approval.
func granular() protocol.AskForApproval {
	yes := true
	return protocol.AskForApproval{Granular: &protocol.GranularAskForApproval{Granular: protocol.GranularAskForApprovalGranular{
		SandboxApproval: true, RequestPermissions: &yes, Rules: true, SkillApproval: &yes, McpElicitations: true,
	}}}
}

// approvalFor is the mode's approval policy (verified against codex-cli
// 0.150.1). File edits are gated by this, not the sandbox: under untrusted
// every edit prompts, under granular an in-workspace edit auto-runs and only
// an escape is raised.
//
//   - auto, acceptEdits: granular; they differ only in the reviewer.
//   - bypassPermissions: never.
//   - plan: on-request, so reads run freely (untrusted would raise them and
//     plan's decline fallback block them); native plan mode refuses writes.
//   - default, manual, dontAsk: untrusted.
func approvalFor(mode Mode) protocol.AskForApproval {
	switch mode {
	case Auto, AcceptEdits:
		return granular()
	case BypassPermissions:
		return protocol.AskForApproval{Value: "never"}
	case Plan:
		return protocol.AskForApproval{Value: "on-request"}
	}
	return protocol.AskForApproval{Value: "untrusted"}
}

// reviewerFor: auto routes escapes to Codex's model (auto_review, the analog
// of Claude's auto classifier); default, manual and acceptEdits to the human
// (user, set explicitly); the rest need none.
func reviewerFor(mode Mode) protocol.ApprovalsReviewer {
	switch mode {
	case Auto:
		return protocol.ApprovalsReviewerAutoReview
	case Default, Manual, AcceptEdits:
		return protocol.ApprovalsReviewerUser
	}
	return ""
}

// networkEnabled mirrors Claude's actual network: unsandboxed, Claude's bash
// has full network, so Codex does too. Under Claude's sandbox it is
// default-deny, opened by an allowlist (sandbox.network or WebFetch(domain:))
// or strictAllowlist.
func networkEnabled(s Effective) bool {
	if s.SandboxEnabled == nil || !*s.SandboxEnabled {
		return true
	}
	if len(s.AllowedDomains) > 0 || (s.StrictAllowlist != nil && *s.StrictAllowlist) {
		return true
	}
	for _, r := range s.Allow {
		if isWebFetchDomainAllow(r) {
			return true
		}
	}
	return false
}

// bashPrefixes turns Bash(...) rules into command-token prefixes; other rules
// are for other surfaces, and a bare Bash is dropped rather than becoming an
// allow-everything prefix.
func bashPrefixes(rules []string) [][]string {
	out := [][]string{}
	for _, r := range rules {
		if p := bashPrefix(r); len(p) > 0 {
			out = append(out, p)
		}
	}
	return out
}

// fetchAllows is the allow prefixes plus curl and wget when a
// WebFetch(domain:) rule is present: Codex has no fetch tool, so the shell is
// how it honours "you may reach this host", and the network allowlist scopes
// which hosts.
func fetchAllows(s Effective) [][]string {
	prefixes := bashPrefixes(s.Allow)
	for _, r := range s.Allow {
		if isWebFetchDomainAllow(r) {
			return append(prefixes, []string{"curl"}, []string{"wget"})
		}
	}
	return prefixes
}

var bashRule = regexp.MustCompile(`^Bash\((.+)\)$`)

// bashPrefix is the token prefix of a Bash(...) rule: Bash(npm run test:*)
// is [npm run test]. A trailing `:*` or `*` ends it.
func bashPrefix(rule string) []string {
	m := bashRule.FindStringSubmatch(strings.TrimSpace(rule))
	if m == nil {
		return nil
	}
	var tokens []string
	for _, t := range strings.Fields(strings.TrimSpace(m[1])) {
		if t == "*" {
			break
		}
		if i := strings.IndexAny(t, ":*"); i != -1 {
			if i > 0 {
				tokens = append(tokens, t[:i])
			}
			break
		}
		tokens = append(tokens, t)
	}
	return tokens
}
