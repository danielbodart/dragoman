package protocol

import (
	"encoding/json"
	"testing"
)

// The protocol is Codex's. Each of these is a message the current schema
// allows, edited the way a later codex might send it: the next release must
// not be the first time we find out how Dragoman takes it.

func TestAnUnknownUnionVariantKeepsItsTypeAndRawJSON(t *testing.T) {
	raw := `{"type":"someFutureItem","id":"x1","shiny":true}`
	var item ThreadItem
	if err := Decode([]byte(raw), &item); err != nil {
		t.Fatal(err)
	}
	if item.Type != "someFutureItem" || string(item.Raw) != raw || item.CommandExecution != nil {
		t.Fatalf("got %+v", item)
	}
	// And it goes back out as it came in.
	out, _ := json.Marshal(item)
	if string(out) != raw {
		t.Fatalf("got %s", out)
	}
}

func TestAnExtraFieldIsIgnored(t *testing.T) {
	var item ThreadItem
	if err := Decode([]byte(`{"type":"plan","id":"p","text":"do it","newField":{"a":[1]}}`), &item); err != nil {
		t.Fatal(err)
	}
	if item.Plan == nil || item.Plan.Text != "do it" {
		t.Fatalf("got %+v", item)
	}
}

func TestAnUnknownEnumValueDecodes(t *testing.T) {
	var item ThreadItem
	_ = Decode([]byte(`{"type":"commandExecution","id":"c","command":"ls","cwd":"/","commandActions":[],"status":"someFutureStatus"}`), &item)
	if item.CommandExecution == nil || item.CommandExecution.Status != "someFutureStatus" {
		t.Fatalf("got %+v", item)
	}
	var reviewer ApprovalsReviewer
	if err := Decode([]byte(`"some_future_reviewer"`), &reviewer); err != nil || reviewer != "some_future_reviewer" {
		t.Fatalf("got %q, %v", reviewer, err)
	}
}

func TestAMissingOptionalFieldIsNil(t *testing.T) {
	var item ThreadItem
	_ = Decode([]byte(`{"type":"commandExecution","id":"c","command":"ls","cwd":"/","commandActions":[],"status":"completed"}`), &item)
	c := item.CommandExecution
	if c == nil || c.ExitCode != nil || c.DurationMs != nil || c.AggregatedOutput != nil {
		t.Fatalf("got %+v", c)
	}
}

// A field whose type changes is left zero; everything else still decodes,
// in the variant and around it.
func TestAFieldOfTheWrongTypeIsLeftZero(t *testing.T) {
	var n ItemCompletedNotification
	err := Decode([]byte(`{"threadId":"t1","turnId":"u","completedAtMs":"soon","item":{"type":"commandExecution","id":"c","command":"ls","cwd":"/","commandActions":{"not":"a list"},"status":"failed","exitCode":"2"}}`), &n)
	if err != nil {
		t.Fatal(err)
	}
	c := n.Item.CommandExecution
	// encoding/json allocates a pointer before it finds the type wrong, so a
	// mistyped optional is a pointer to zero.
	if n.ThreadId != "t1" || c == nil || c.Command != "ls" || c.Status != "failed" || (c.ExitCode != nil && *c.ExitCode != 0) || n.CompletedAtMs != 0 {
		t.Fatalf("got %+v / %+v", n, c)
	}
}

func TestOnlyJSONThatDoesNotParseIsAnError(t *testing.T) {
	var n ItemCompletedNotification
	if Decode([]byte(`{"threadId":`), &n) == nil {
		t.Fatal("want an error")
	}
	if Decode(nil, &n) != nil {
		t.Fatal("nothing is nothing")
	}
}

func TestAStringOrObjectUnionTakesEither(t *testing.T) {
	var d CommandExecutionApprovalDecision
	_ = Decode([]byte(`"acceptForSession"`), &d)
	if d.Value != "acceptForSession" {
		t.Fatalf("got %+v", d)
	}
	_ = Decode([]byte(`{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["ls"]}}`), &d)
	if d.AcceptWithExecpolicyAmendment == nil || d.AcceptWithExecpolicyAmendment.AcceptWithExecpolicyAmendment.ExecpolicyAmendment[0] != "ls" {
		t.Fatalf("got %+v", d)
	}
	_ = Decode([]byte(`{"someFutureDecision":{}}`), &d)
	if d.Value != "" || d.AcceptWithExecpolicyAmendment != nil || string(d.Raw) != `{"someFutureDecision":{}}` {
		t.Fatalf("got %+v", d)
	}
}

// A discriminated variant built for sending gets its discriminator filled
// in.
func TestAVariantMarshalsWithItsDiscriminator(t *testing.T) {
	b, _ := json.Marshal(ReviewTarget{BaseBranch: &BaseBranchReviewTarget{Branch: "main"}})
	if string(b) != `{"branch":"main","type":"baseBranch"}` {
		t.Fatalf("got %s", b)
	}
}
