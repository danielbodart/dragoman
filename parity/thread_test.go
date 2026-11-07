//go:build parity

package parity

// Parity, Go side: the same two halves as thread.ts, driven by env:
// PARITY_MODE=start PARITY_ARG=TOKEN, or PARITY_MODE=resume PARITY_ARG=ID,
// with PARITY_CWD and DRAGOMAN_HOME.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/danielbodart/dragoman/internal/app"
	"github.com/danielbodart/dragoman/internal/codex"
	"github.com/danielbodart/dragoman/internal/codexhome"
	"github.com/danielbodart/dragoman/internal/posture"
	"github.com/danielbodart/dragoman/internal/protocol"
	"github.com/danielbodart/dragoman/internal/run"
	"github.com/danielbodart/gokit/environ"
	"github.com/danielbodart/gokit/logx"
)

type decline struct{}

func (decline) Ask(context.Context, run.Approval) (string, error) { return "decline", nil }

func command() []string {
	if v := os.Getenv("DRAGOMAN_CODEX_COMMAND"); v != "" {
		return strings.Split(v, " ")
	}
	return []string{"codex", "app-server"}
}

func TestThread(t *testing.T) {
	mode, arg, cwd := os.Getenv("PARITY_MODE"), os.Getenv("PARITY_ARG"), os.Getenv("PARITY_CWD")
	env := environ.Current()
	home, _ := os.UserHomeDir()
	ctx := context.Background()
	switch mode {
	case "start":
		c := &app.Container{Env: env, Home: home, Log: logx.Writers(os.Stderr, os.Stderr), CodexCommand: command(),
			Settings: func() posture.Effective { return posture.Effective{} }, Elicitation: decline{}}
		if err := c.Wire(ctx); err != nil {
			t.Fatal(err)
		}
		h, err := c.Runs.Start(ctx, "Remember this exact token: "+arg+". Reply with only the word ok.", cwd, "default")
		if err != nil {
			t.Fatal(err)
		}
		for {
			rec, _ := c.Runs.Status(h)
			if rec.Status == run.Done || rec.Status == run.Failed {
				break
			}
			time.Sleep(500 * time.Millisecond)
		}
		c.Runs.CloseAll()
		fmt.Println("THREAD", h)
	case "resume":
		layout := codexhome.LayoutFrom(env, home)
		layout.IsolatedHome = filepath.Join(env["DRAGOMAN_HOME"], "runs", "resume-go", "codex-home")
		codexHome, err := codexhome.Ensure(nil, layout, "")
		if err != nil {
			t.Fatal(err)
		}
		conn, err := codex.Start(ctx, command(), map[string]string{"CODEX_HOME": codexHome})
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		if _, err := conn.Request(ctx, "thread/resume", map[string]any{"threadId": arg, "cwd": cwd, "approvalPolicy": "untrusted", "sandbox": "read-only"}); err != nil {
			t.Fatal(err)
		}
		if _, err := conn.Request(ctx, "turn/start", map[string]any{"threadId": arg, "input": []any{map[string]any{"type": "text", "text": "What exact token did I ask you to remember earlier? Reply with only that token.", "text_elements": []any{}}}}); err != nil {
			t.Fatal(err)
		}
		for n := range conn.Notifications() {
			if n.Method == "turn/completed" {
				var p protocol.TurnCompletedNotification
				_ = json.Unmarshal(n.Params, &p)
				for i := len(p.Turn.Items) - 1; i >= 0; i-- {
					if m := p.Turn.Items[i].AgentMessage; m != nil {
						fmt.Println("ANSWER", m.Text)
						return
					}
				}
				fmt.Println("ANSWER")
				return
			}
		}
	}
}
