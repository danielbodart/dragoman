//go:build parity

package parity

// Parity dump, Go side: the same as dump.ts.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/danielbodart/dragoman/internal/codexhome"
	"github.com/danielbodart/dragoman/internal/posture"
)

type fixture struct {
	DefaultMode           *string  `json:"defaultMode"`
	Allow                 []string `json:"allow"`
	Deny                  []string `json:"deny"`
	AdditionalDirectories []string `json:"additionalDirectories"`
	SandboxEnabled        *bool    `json:"sandboxEnabled"`
	DenyRead              []string `json:"denyRead"`
	DenyWrite             []string `json:"denyWrite"`
	AllowRead             []string `json:"allowRead"`
	AllowWrite            []string `json:"allowWrite"`
	AllowedDomains        []string `json:"allowedDomains"`
	DeniedDomains         []string `json:"deniedDomains"`
	StrictAllowlist       *bool    `json:"strictAllowlist"`
}

func TestDump(t *testing.T) {
	raw, _ := os.ReadFile("fixtures.json")
	var fixtures []json.RawMessage
	_ = json.Unmarshal(raw, &fixtures)
	var out []any
	for _, fr := range fixtures {
		var f fixture
		_ = json.Unmarshal(fr, &f)
		s := posture.Effective{DefaultMode: f.DefaultMode, Allow: f.Allow, Deny: f.Deny, AdditionalDirectories: f.AdditionalDirectories, SandboxEnabled: f.SandboxEnabled,
			DenyRead: f.DenyRead, DenyWrite: f.DenyWrite, AllowRead: f.AllowRead, AllowWrite: f.AllowWrite, AllowedDomains: f.AllowedDomains, DeniedDomains: f.DeniedDomains, StrictAllowlist: f.StrictAllowlist}
		for _, p := range []string{"", "plan", "default", "manual", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "nonsense"} {
			mode, _ := posture.ResolveMode(s, p)
			policy := posture.Mirror(s, mode)
			root := t.TempDir()
			real := filepath.Join(root, "real")
			_ = os.Mkdir(real, 0o755)
			_ = os.WriteFile(filepath.Join(real, "auth.json"), []byte("{}"), 0o644)
			_ = os.WriteFile(filepath.Join(real, "config.toml"), []byte("model = \"x\"\n"), 0o644)
			var profiles []codexhome.Profile
			if policy.Profile != nil {
				profiles = []codexhome.Profile{*policy.Profile}
			}
			home, err := codexhome.Ensure(profiles, codexhome.Layout{RealHome: real, IsolatedHome: filepath.Join(root, "home"), SharedStore: filepath.Join(root, "shared")}, codexhome.RenderRules(policy.ExecpolicyAmendments, policy.DenyPrefixes))
			if err != nil {
				t.Fatal(err)
			}
			files := map[string]string{}
			entries, _ := os.ReadDir(home)
			names := []string{}
			for _, e := range entries {
				names = append(names, e.Name())
			}
			sort.Strings(names)
			for _, name := range names {
				path := filepath.Join(home, name)
				info, _ := os.Lstat(path)
				switch {
				case info.Mode()&os.ModeSymlink != 0:
					target, _ := os.Readlink(path)
					files[name] = "-> " + strings.Replace(target, root, "$ROOT", 1)
				case info.IsDir():
					files[name] = "dir"
				default:
					b, _ := os.ReadFile(path)
					files[name] = string(b)
				}
			}
			rules, _ := os.ReadFile(filepath.Join(home, "rules", "dragoman.rules"))
			var postureOut any
			if p != "" {
				postureOut = p
			}
			out = append(out, map[string]any{
				"fixture": json.RawMessage(fr), "posture": postureOut, "mode": mode,
				"approvalPolicy": policy.ApprovalPolicy, "reviewer": policy.ApprovalsReviewer, "commandFallback": policy.CommandFallback, "fileChange": policy.FileChange,
				"amendments": policy.ExecpolicyAmendments, "deny": policy.DenyPrefixes, "collaborationMode": policy.CollaborationMode,
				"block": codexhome.RenderManagedBlock(profiles), "files": files, "rules": string(rules),
			})
		}
	}
	b, _ := json.MarshalIndent(out, "", " ")
	fmt.Println(string(b))
}
