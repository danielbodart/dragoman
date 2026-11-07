package codex

import (
	"io"
	"slices"
	"strings"
	"testing"
)

// chunks is a reader that delivers exactly the given chunks, one per Read.
type chunks struct{ parts []string }

func (c *chunks) Read(p []byte) (int, error) {
	if len(c.parts) == 0 {
		return 0, io.EOF
	}
	n := copy(p, c.parts[0])
	c.parts[0] = c.parts[0][n:]
	if c.parts[0] == "" {
		c.parts = c.parts[1:]
	}
	return n, nil
}

func collect(t *testing.T, parts ...string) []string {
	t.Helper()
	var out []string
	if err := lines(&chunks{parts: parts}, func(l []byte) { out = append(out, string(l)) }); err != nil {
		t.Fatal(err)
	}
	return out
}

func expectLines(t *testing.T, got []string, want ...string) {
	t.Helper()
	if !slices.Equal(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestLinesSplitsWholeLinesDeliveredInOneChunk(t *testing.T) {
	expectLines(t, collect(t, "{\"a\":1}\n{\"b\":2}\n"), `{"a":1}`, `{"b":2}`)
}

// The app-server delivers bytes in arbitrary chunks, so a JSON object can be
// torn in half mid-line and must be held back until the newline arrives.
func TestLinesReassemblesALineSplitAcrossChunks(t *testing.T) {
	expectLines(t, collect(t, `{"a":`, "1}\n"), `{"a":1}`)
}

// A final unterminated fragment is not a line yet: yielding it would emit
// invalid JSON.
func TestLinesHoldsBackATrailingPartialLineWithNoNewline(t *testing.T) {
	expectLines(t, collect(t, "{\"a\":1}\n{\"b"), `{"a":1}`)
}

func TestLinesEmitsSeveralLinesFromASingleChunk(t *testing.T) {
	expectLines(t, collect(t, "{\"a\":1}\n{\"b\":2}\n{\"c\":3}\n"), `{"a":1}`, `{"b":2}`, `{"c":3}`)
}

func TestLinesSkipsBlankLinesRatherThanYieldingEmptyStrings(t *testing.T) {
	expectLines(t, collect(t, "{\"a\":1}\n\n{\"b\":2}\n"), `{"a":1}`, `{"b":2}`)
}

func TestLinesTrimsSurroundingWhitespaceOnEachLine(t *testing.T) {
	expectLines(t, collect(t, "  {\"a\":1}  \n"), `{"a":1}`)
}

// One byte at a time is the most torn a stream can be.
func TestLinesSurvivesOneByteChunks(t *testing.T) {
	text := "{\"a\":1}\n{\"b\":2}\n"
	expectLines(t, collect(t, strings.Split(text, "")...), `{"a":1}`, `{"b":2}`)
}
