//go:build parity

package parity

import (
	"fmt"
	"os"
	"testing"

	"github.com/danielbodart/dragoman/internal/posture"
	"github.com/danielbodart/gokit/environ"
)

// TS hook wrote toolu_TS1; Go takes it, and records toolu_GO1 for TS.
func TestLiveModeHandoff(t *testing.T) {
	env := environ.Env{"XDG_RUNTIME_DIR": os.Getenv("PARITY_RT")}
	fmt.Println("go took:", posture.TakeLiveMode("toolu_TS1", env))
	if err := posture.RecordLiveMode("toolu_GO1", "plan", env); err != nil {
		t.Fatal(err)
	}
}
