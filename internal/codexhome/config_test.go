package codexhome

import (
	"strings"
	"testing"
)

func contains(t *testing.T, s, sub string) {
	t.Helper()
	if !strings.Contains(s, sub) {
		t.Fatalf("missing %q in:\n%s", sub, s)
	}
}

func lacks(t *testing.T, s, sub string) {
	t.Helper()
	if strings.Contains(s, sub) {
		t.Fatalf("unexpected %q in:\n%s", sub, s)
	}
}

func equal[T comparable](t *testing.T, got, want T) {
	t.Helper()
	if got != want {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestRenderRulesDenyIsForbiddenAllowIsAllowDenyFirst(t *testing.T) {
	equal(t, RenderRules([][]string{{"npm", "run", "test"}}, [][]string{{"git", "push"}}),
		`prefix_rule(pattern=["git", "push"], decision="forbidden", justification="Claude deny rule")`+"\n"+
			`prefix_rule(pattern=["npm", "run", "test"], decision="allow")`+"\n")
}

func TestRenderRulesNoRulesIsEmpty(t *testing.T) {
	equal(t, RenderRules(nil, nil), "")
}

// A token with a quote or backslash must not break the rule syntax.
func TestRenderRulesTokensAreJSONEscaped(t *testing.T) {
	equal(t, RenderRules([][]string{{`weird"tok`}}, nil), `prefix_rule(pattern=["weird\"tok"], decision="allow")`+"\n")
}

func TestRenderRulesOnlyDenyAndOnlyAllowEachRender(t *testing.T) {
	contains(t, RenderRules(nil, [][]string{{"rm", "-rf"}}), `decision="forbidden"`)
	equal(t, RenderRules([][]string{{"ls"}}, nil), `prefix_rule(pattern=["ls"], decision="allow")`+"\n")
}

var profile = Profile{
	ID:      "dragoman-workspace",
	Base:    ":workspace",
	Network: &Network{Enabled: true, Domains: []Entry{{"example.com", "allow"}, {"example.org", "deny"}}},
}

func TestRenderManagedBlockEmitsProxyProfileBaseAndDomains(t *testing.T) {
	block := RenderManagedBlock([]Profile{profile})
	contains(t, block, "[features.network_proxy]\nenabled = true")
	contains(t, block, "[permissions.dragoman-workspace]\nextends = \":workspace\"")
	contains(t, block, "[permissions.dragoman-workspace.network]\nenabled = true")
	contains(t, block, "[permissions.dragoman-workspace.network.domains]\n\"example.com\" = \"allow\"\n\"example.org\" = \"deny\"")
}

func TestRenderManagedBlockNoProfilesIsEmpty(t *testing.T) {
	equal(t, RenderManagedBlock(nil), "")
}

func TestRenderManagedBlockNetworkWithoutDomainsHasNoDomainsTableOrProxy(t *testing.T) {
	block := RenderManagedBlock([]Profile{{ID: "dragoman-plan", Base: ":read-only", Network: &Network{Enabled: false}}})
	contains(t, block, "[permissions.dragoman-plan.network]\nenabled = false")
	lacks(t, block, "network.domains")
	lacks(t, block, "network_proxy")
}

func TestRenderManagedBlockProxyOnlyWhenSomeProfileHasDomains(t *testing.T) {
	contains(t, RenderManagedBlock([]Profile{profile}), "[features.network_proxy]\nenabled = true")
	lacks(t, RenderManagedBlock([]Profile{{ID: "p", Base: ":workspace", Network: &Network{Enabled: true}}}), "network_proxy")
}

// A bare default_permissions appended after a user's [table] would land
// inside that table: the block holds only [table] headers and their keys.
func TestRenderManagedBlockIsAllTableSections(t *testing.T) {
	block := RenderManagedBlock([]Profile{profile})
	lacks(t, block, "default_permissions")
	lines := strings.Split(block, "\n")
	for _, line := range lines[1 : len(lines)-1] {
		if strings.TrimSpace(line) == "" {
			continue
		}
		if !strings.HasPrefix(line, "[") && !strings.Contains(line, "=") {
			t.Fatalf("not a header or a key: %q", line)
		}
	}
}

func withFS(fs *Filesystem) Profile {
	return Profile{ID: "dragoman-workspace", Base: ":workspace", Filesystem: fs}
}

func TestRenderManagedBlockFilesystemPathsAndWorkspaceRoots(t *testing.T) {
	block := RenderManagedBlock([]Profile{withFS(&Filesystem{
		Paths:          []Entry{{"/a/secret", "deny"}, {"/b/out", "write"}},
		WorkspaceRoots: []Entry{{"**/*.env", "deny"}, {".", "write"}},
	})})
	contains(t, block, "[permissions.dragoman-workspace.filesystem]\n\"/a/secret\" = \"deny\"\n\"/b/out\" = \"write\"")
	contains(t, block, "[permissions.dragoman-workspace.filesystem.\":workspace_roots\"]\n\"**/*.env\" = \"deny\"\n\".\" = \"write\"")
}

// The parent table's key must come before the sub-table header.
func TestRenderManagedBlockGlobScanMaxDepthLeadsTheTable(t *testing.T) {
	depth := 3
	block := RenderManagedBlock([]Profile{withFS(&Filesystem{WorkspaceRoots: []Entry{{"**/*.env", "deny"}}, GlobScanMaxDepth: &depth})})
	at, sub := strings.Index(block, "glob_scan_max_depth = 3"), strings.Index(block, `.filesystem.":workspace_roots"`)
	if at == -1 || at > sub {
		t.Fatalf("depth at %d, sub-table at %d:\n%s", at, sub, block)
	}
}

func TestRenderManagedBlockEmptyFilesystemRendersNoTable(t *testing.T) {
	lacks(t, RenderManagedBlock([]Profile{withFS(&Filesystem{})}), "filesystem")
}

func TestRenderManagedBlockADepthAloneIsNoRule(t *testing.T) {
	depth := 5
	lacks(t, RenderManagedBlock([]Profile{withFS(&Filesystem{GlobScanMaxDepth: &depth})}), "filesystem")
}

const userConfig = "approval_policy = \"on-request\"\napprovals_reviewer = \"auto_review\"\n"

func TestSpliceAppendsPreservingTheUsersContent(t *testing.T) {
	out := SpliceManagedBlock(userConfig, RenderManagedBlock([]Profile{profile}))
	contains(t, out, `approval_policy = "on-request"`)
	contains(t, out, "DRAGOMAN MANAGED")
	if strings.Index(out, "approval_policy") > strings.Index(out, "DRAGOMAN") {
		t.Fatal("the user's config should come first")
	}
}

func TestSpliceReplacesAnExistingBlockRatherThanStacking(t *testing.T) {
	first := SpliceManagedBlock(userConfig, RenderManagedBlock([]Profile{profile}))
	only := profile
	only.Network = &Network{Enabled: true, Domains: []Entry{{"only.com", "allow"}}}
	second := SpliceManagedBlock(first, RenderManagedBlock([]Profile{only}))
	equal(t, strings.Count(second, "DRAGOMAN MANAGED (do not edit"), 1)
	contains(t, second, `"only.com" = "allow"`)
	lacks(t, second, `"example.org" = "deny"`)
	contains(t, second, `approval_policy = "on-request"`)
}

func TestStripReturnsTheConfigToItsPreSpliceContent(t *testing.T) {
	spliced := SpliceManagedBlock(userConfig, RenderManagedBlock([]Profile{profile}))
	equal(t, strings.TrimSpace(StripManagedBlock(spliced)), strings.TrimSpace(userConfig))
}

func TestStripIsANoOpWithoutABlock(t *testing.T) {
	equal(t, StripManagedBlock(userConfig), userConfig)
}

func TestSpliceIntoEmptyConfigIsJustTheBlock(t *testing.T) {
	if !strings.HasPrefix(SpliceManagedBlock("", RenderManagedBlock([]Profile{profile})), "# >>> DRAGOMAN MANAGED") {
		t.Fatal("want just the block")
	}
}

// A half-written block is left alone rather than guessed at.
func TestStripLeavesAHalfWrittenBlockAlone(t *testing.T) {
	half := userConfig + "\n" + beginMarker + "\n[permissions.x]\n"
	equal(t, StripManagedBlock(half), half)
}

func TestHasDefaultPermissionsSeesTheUsersValueNotOurs(t *testing.T) {
	equal(t, HasDefaultPermissions("default_permissions = \":danger-full-access\"\n"), true)
	equal(t, HasDefaultPermissions("approval_policy = \"on-request\"\n"), false)
	equal(t, HasDefaultPermissions(SpliceManagedBlock("approval_policy = \"on-request\"\n", RenderManagedBlock([]Profile{profile}))), false)
}

func TestWithDefaultPermissionsPrependsARootKey(t *testing.T) {
	config := SpliceManagedBlock("approval_policy = \"on-request\"\n", RenderManagedBlock([]Profile{profile}))
	out := WithDefaultPermissions(config, ":workspace")
	if !strings.HasPrefix(out, "default_permissions = \":workspace\"\n") {
		t.Fatalf("got:\n%s", out)
	}
	equal(t, strings.Count(out, "default_permissions"), 1)
}

func TestWithDefaultPermissionsKeepsTheUsersValue(t *testing.T) {
	config := "default_permissions = \":danger-full-access\"\napproval_policy = \"on-request\"\n"
	equal(t, WithDefaultPermissions(config, ":workspace"), config)
}
