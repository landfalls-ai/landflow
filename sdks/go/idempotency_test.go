package landflow

import (
	"context"
	"encoding/json"
	"testing"

	"google.golang.org/protobuf/proto"

	pb "github.com/landflow/landflow/sdks/go/landflowpb"
)

func TestIdempotencyKey(t *testing.T) {
	// HTTP: the JSON field reaches ctx.IdempotencyKey(); empty when an older host leaves it out.
	var req ExecuteRequest
	body := `{"protocol":"landflow.plugin/v1","executionId":"ex_1","mode":"manual","node":{"id":"n1","name":"N","type":"test-plugin.upper","typeVersion":1},` +
		`"parameters":{},"itemParameters":[],"inputs":[],"idempotencyKey":"ex_1:n1:0"}`
	if err := json.Unmarshal([]byte(body), &req); err != nil {
		t.Fatal(err)
	}
	if got := NewExecuteContext(context.Background(), &req, nil).IdempotencyKey(); got != "ex_1:n1:0" {
		t.Errorf("IdempotencyKey() = %q", got)
	}
	if got := NewExecuteContext(context.Background(), execReq("test-plugin.upper", nil), nil).IdempotencyKey(); got != "" {
		t.Errorf("IdempotencyKey() without a key = %q", got)
	}
	var encoded map[string]any
	if data, err := json.Marshal(execReq("test-plugin.upper", nil)); err != nil || json.Unmarshal(data, &encoded) != nil {
		t.Fatal(err)
	}
	if _, ok := encoded["idempotencyKey"]; ok {
		t.Error("an empty idempotencyKey is serialized")
	}

	// gRPC: survives ExecuteRequest -> proto wire bytes -> ExecuteRequest.
	for _, key := range []string{"ex_1:n1:2", ""} {
		r := execReq("test-plugin.upper", nil)
		r.IdempotencyKey = key
		msg, err := ExecuteRequestToProto(r)
		if err != nil {
			t.Fatal(err)
		}
		wire, err := proto.Marshal(msg)
		if err != nil {
			t.Fatal(err)
		}
		var decoded pb.ExecuteRequest
		if err := proto.Unmarshal(wire, &decoded); err != nil {
			t.Fatal(err)
		}
		back, err := executeRequestFromProto(&decoded)
		if err != nil || back.IdempotencyKey != key {
			t.Errorf("idempotencyKey %q after gRPC round trip = %q (%v)", key, back.IdempotencyKey, err)
		}
	}
}
