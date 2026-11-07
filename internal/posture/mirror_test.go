package posture

import (
	"fmt"
	"testing"

	"github.com/danielbodart/dragoman/internal/codexhome"
)

func TestResolveModeAnExplicitPostureWins(t *testing.T) {
	mode, _ := ResolveMode(Effective{DefaultMode: ptr("default")}, "plan")
	same(t, mode, Plan)
}

func TestResolveModeFallsBackToTheStaticDefaultMode(t *testing.T) {
	mode, _ := ResolveMode(Effective{DefaultMode: ptr("acceptEdits")}, "")
	same(t, mode, AcceptEdits)
}

func TestResolveModeFallsBackToTheSafeDefault(t *testing.T) {
	mode, unknown := ResolveMode(Effective{}, "")
	same(t, mode, Default)
	same(t, unknown, "")
}

func TestResolveModeAcceptsManualAsTheCLIAliasOfDefault(t *testing.T) {
	mode, _ := ResolveMode(Effective{DefaultMode: ptr("manual")}, "")
	same(t, mode, Manual)
}

// A new Claude mode degrades to the most cautious posture, and is named so
// the caller can warn once; it never fails.
func TestResolveModeAnUnrecognisedModeDegradesToTheSafeDefault(t *testing.T) {
	mode, unknown := ResolveMode(Effective{DefaultMode: ptr("some-future-mode")}, "")
	same(t, mode, Default)
	same(t, unknown, "some-future-mode")
	mode, unknown = ResolveMode(Effective{}, "nonsense")
	same(t, mode, Default)
	same(t, unknown, "nonsense")
}

func approval(p Policy) string {
	if p.ApprovalPolicy.Granular != nil {
		return "granular"
	}
	return p.ApprovalPolicy.Value
}

func TestMirrorModeToApprovalPolicy(t *testing.T) {
	for mode, want := range map[Mode]string{
		Auto: "granular", AcceptEdits: "granular", BypassPermissions: "never", Plan: "on-request",
		Default: "untrusted", Manual: "untrusted", DontAsk: "untrusted",
	} {
		t.Run(string(mode), func(t *testing.T) { same(t, approval(Mirror(Effective{}, mode)), want) })
	}
}

// granular raises sandbox escapes for review, with every toggle on.
func TestGranularCarriesEveryToggle(t *testing.T) {
	g := Mirror(Effective{}, Auto).ApprovalPolicy.Granular.Granular
	if !g.SandboxApproval || !g.Rules || !g.McpElicitations || !*g.RequestPermissions || !*g.SkillApproval {
		t.Fatalf("got %+v", g)
	}
}

func TestMirrorModeToApprovalsReviewer(t *testing.T) {
	for mode, want := range map[Mode]string{
		Auto: "auto_review", Default: "user", Manual: "user", AcceptEdits: "user",
		Plan: "", DontAsk: "", BypassPermissions: "",
	} {
		t.Run(string(mode), func(t *testing.T) { same(t, string(Mirror(Effective{}, mode).ApprovalsReviewer), want) })
	}
}

func TestMirrorDontAskAndPlanRefuseUnmatchedCommandsAndEdits(t *testing.T) {
	for _, mode := range []Mode{DontAsk, Plan} {
		p := Mirror(Effective{}, mode)
		same(t, p.CommandFallback, Decline)
		same(t, p.FileChange, Decline)
	}
}

// Under acceptEdits's granular policy in-scope edits already auto-run, so
// these paths only see escapes, which Claude prompts for.
func TestMirrorAcceptEditsElicitsAndAddsNoFilesystemCommandAllows(t *testing.T) {
	p := Mirror(Effective{}, AcceptEdits)
	same(t, p.FileChange, Elicit)
	same(t, p.CommandFallback, Elicit)
	same(t, p.ExecpolicyAmendments, [][]string{})
}

func TestMirrorTheAskingModesElicitCommandsAndEdits(t *testing.T) {
	for _, mode := range []Mode{Default, Manual, Auto, AcceptEdits} {
		p := Mirror(Effective{}, mode)
		same(t, p.CommandFallback, Elicit)
		same(t, p.FileChange, Elicit)
	}
}

func TestMirrorScope(t *testing.T) {
	sandboxed := Effective{SandboxEnabled: ptr(true)}
	for mode, want := range map[Mode]string{AcceptEdits: ":workspace", Auto: ":workspace", Plan: ":read-only", Default: ":read-only", Manual: ":read-only", DontAsk: ":read-only"} {
		t.Run(string(mode), func(t *testing.T) {
			same(t, Mirror(Effective{}, mode).Profile.Base, want)
			same(t, Mirror(sandboxed, mode).Profile.Base, want)
		})
	}
	if Mirror(Effective{}, BypassPermissions).Profile != nil || Mirror(sandboxed, BypassPermissions).Profile != nil {
		t.Fatal("bypassPermissions has no profile: danger-full-access")
	}
}

func TestMirrorCollaborationMode(t *testing.T) {
	same(t, string(Mirror(Effective{}, Plan).CollaborationMode), "plan")
	for _, mode := range []Mode{Default, Manual, AcceptEdits, Auto, DontAsk, BypassPermissions} {
		same(t, string(Mirror(Effective{}, mode).CollaborationMode), "")
	}
}

func enabled(s Effective) bool { return Mirror(s, Default).Profile.Network.Enabled }

func TestNetworkMirrorsClaudesActualPosture(t *testing.T) {
	same(t, enabled(Effective{}), true)
	same(t, enabled(Effective{SandboxEnabled: ptr(true)}), false)
	same(t, enabled(Effective{SandboxEnabled: ptr(true), AllowedDomains: []string{"api.example.com"}}), true)
	same(t, enabled(Effective{SandboxEnabled: ptr(true), StrictAllowlist: ptr(true)}), true)
	same(t, enabled(Effective{SandboxEnabled: ptr(true), Allow: []string{"WebFetch(domain:example.com)"}}), true)
}

func TestTheHostAllowlistIsEmittedWhateverTheSandbox(t *testing.T) {
	rules := Effective{AllowedDomains: []string{"api.example.com"}, Allow: []string{"WebFetch(domain:x.com)"}, DeniedDomains: []string{"bad.com"}}
	want := entries("api.example.com", "allow", "x.com", "allow", "bad.com", "deny")
	same(t, Mirror(rules, Default).Profile.Network.Domains, want)
	rules.SandboxEnabled = ptr(true)
	same(t, Mirror(rules, Default).Profile.Network.Domains, want)
}

func prefixes(s Effective) [][]string { return Mirror(s, Default).ExecpolicyAmendments }

func TestAWebFetchRuleImpliesCurlAndWget(t *testing.T) {
	same(t, prefixes(Effective{Allow: []string{"WebFetch(domain:example.com)"}}), [][]string{{"curl"}, {"wget"}})
	same(t, prefixes(Effective{Allow: []string{"Bash(npm run test:*)", "WebFetch(domain:example.com)"}}), [][]string{{"npm", "run", "test"}, {"curl"}, {"wget"}})
	same(t, prefixes(Effective{Allow: []string{"Bash(ls:*)"}}), [][]string{{"ls"}})
	same(t, prefixes(Effective{}), [][]string{})
}

func TestAllowRulesBecomeExecpolicyAmendments(t *testing.T) {
	same(t, prefixes(Effective{Allow: []string{"Bash(npm run test:*)"}}), [][]string{{"npm", "run", "test"}})
	same(t, prefixes(Effective{Allow: []string{"Read(/src/**)", "Edit(/x)"}}), [][]string{})
	// A bare Bash must never become an allow-everything empty prefix.
	same(t, prefixes(Effective{Allow: []string{"Bash"}}), [][]string{})
	same(t, prefixes(Effective{Allow: []string{"Bash(git status)", "Bash(ls -la)"}}), [][]string{{"git", "status"}, {"ls", "-la"}})
}

func TestProfiles(t *testing.T) {
	same(t, ProfileFor(Effective{}, AcceptEdits).Base, ":workspace")
	same(t, ProfileFor(Effective{}, Auto).Base, ":workspace")
	same(t, ProfileFor(Effective{}, Default).Base, ":read-only")
	same(t, ProfileFor(Effective{}, Plan).Base, ":read-only")
	if ProfileFor(Effective{}, BypassPermissions) != nil {
		t.Fatal("bypassPermissions: no profile")
	}
	same(t, ProfileFor(Effective{}, Plan).ID, "dragoman-read-only")
	same(t, ProfileFor(Effective{}, Auto).ID, "dragoman-workspace")
	p := ProfileFor(Effective{SandboxEnabled: ptr(true), AllowedDomains: []string{"a.com"}, DeniedDomains: []string{"b.com"}, Allow: []string{"WebFetch(domain:c.com)"}}, Default)
	same(t, *p.Network, codexhome.Network{Enabled: true, Domains: entries("a.com", "allow", "c.com", "allow", "b.com", "deny")})
	same(t, ProfileFor(Effective{SandboxEnabled: ptr(true), AllowedDomains: []string{"a.com"}}, AcceptEdits).Network.Domains, entries("a.com", "allow"))
}

func asMap(entries []codexhome.Entry) map[string]string {
	m := map[string]string{}
	for _, e := range entries {
		m[e.Key] = e.Value
	}
	return m
}

func TestFilesystemForEachListMapsToItsAccess(t *testing.T) {
	fs := FilesystemFor(Effective{DenyRead: []string{"/a/secret"}, DenyWrite: []string{"/a/ro"}, AllowWrite: []string{"/b/out"}, AllowRead: []string{"/c/in"}})
	same(t, asMap(fs.Paths), map[string]string{"/a/secret": "deny", "/a/ro": "read", "/b/out": "write", "/c/in": "read"})
	same(t, fs.WorkspaceRoots, []codexhome.Entry{})
}

func TestFilesystemForEmptySettingsIsAnEmptyAxis(t *testing.T) {
	fs := FilesystemFor(Effective{})
	same(t, fs.Paths, []codexhome.Entry{})
	same(t, fs.WorkspaceRoots, []codexhome.Entry{})
}

func TestFilesystemForRelativePathsAndGlobsAnchorUnderWorkspaceRoots(t *testing.T) {
	fs := FilesystemFor(Effective{DenyRead: []string{"**/*.env", ".aws"}, AllowWrite: []string{"/abs/dir"}})
	same(t, fs.Paths, entries("/abs/dir", "write"))
	same(t, asMap(fs.WorkspaceRoots), map[string]string{"**/*.env": "deny", ".aws": "deny"})
}

func TestFilesystemForAPathInSeveralListsTakesTheMostRestrictive(t *testing.T) {
	same(t, FilesystemFor(Effective{DenyRead: []string{"/x"}, DenyWrite: []string{"/x"}, AllowWrite: []string{"/x"}, AllowRead: []string{"/x"}}).Paths, entries("/x", "deny"))
	same(t, FilesystemFor(Effective{DenyWrite: []string{"/y"}, AllowWrite: []string{"/y"}}).Paths, entries("/y", "read"))
}

func TestFilesystemForDropsBlankEntries(t *testing.T) {
	fs := FilesystemFor(Effective{DenyRead: []string{"  ", ""}})
	same(t, fmt.Sprint(len(fs.Paths), len(fs.WorkspaceRoots)), "0 0")
}

func TestProfileForCarriesTheFilesystemAxis(t *testing.T) {
	same(t, ProfileFor(Effective{SandboxEnabled: ptr(true), DenyRead: []string{"/s"}}, Default).Filesystem.Paths, entries("/s", "deny"))
}

func TestDenyRulesBecomeDenyPrefixes(t *testing.T) {
	same(t, Mirror(Effective{Deny: []string{"Bash(curl:*)", "Bash(git push:*)"}}, Default).DenyPrefixes, [][]string{{"curl"}, {"git", "push"}})
	same(t, Mirror(Effective{Deny: []string{"Read(/etc/**)", "Bash"}}, Default).DenyPrefixes, [][]string{})
}

func entries(kv ...string) []codexhome.Entry {
	out := []codexhome.Entry{}
	for i := 0; i+1 < len(kv); i += 2 {
		out = append(out, codexhome.Entry{Key: kv[i], Value: kv[i+1]})
	}
	return out
}
