// Throwaway: step 0's spikes 3 and 4. Answers one MCP initialize on stdio,
// logging through gokit's logx, to prove a darwin/arm64 binary cross-built
// on Linux runs on Apple silicon from an unpacked zip.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"runtime"

	"github.com/danielbodart/gokit/logx"
)

func main() {
	log := logx.Writers(os.Stderr, os.Stderr)
	log.Log("spike on", runtime.GOOS, runtime.GOARCH)
	in := bufio.NewScanner(os.Stdin)
	for in.Scan() {
		var m struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		if json.Unmarshal(in.Bytes(), &m) == nil && m.Method == "initialize" {
			fmt.Printf(`{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"dragoman","version":"spike"}}}`+"\n", m.ID)
			return
		}
	}
}
