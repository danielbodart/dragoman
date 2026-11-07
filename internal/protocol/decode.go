// Package protocol is Codex's app-server protocol, generated from its JSON
// Schema by ./gen (protocol_gen.go), plus the lenient decoding Dragoman reads
// it with.
package protocol

//go:generate go run ./gen -schema ../../generated/codex-protocol/schema/codex_app_server_protocol.schemas.json -out protocol_gen.go

import (
	"encoding/json"
	"errors"
)

// Decode unmarshals what Codex sent into v, leniently: unknown fields are
// ignored, and a field whose type does not match is left zero while the rest
// still decode. Only JSON that does not parse at all is an error. Codex owns
// this format, so its next release must not be the first time a field's
// change of type stops a run.
func Decode(data []byte, v any) error {
	if len(data) == 0 {
		return nil
	}
	err := json.Unmarshal(data, v)
	var mismatch *json.UnmarshalTypeError
	if errors.As(err, &mismatch) {
		return nil
	}
	return err
}
