package landflow

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"google.golang.org/protobuf/proto"

	pb "github.com/landflow/landflow/sdks/go/landflowpb"
)

type reporterNode struct{}

func (reporterNode) Description() NodeDescriptor {
	return NodeDescriptor{Name: "reporter", DisplayName: "Reporter", Description: "Reports records", Version: V(1)}
}

func (reporterNode) Execute(ctx *ExecuteContext) ([][]Item, error) {
	ctx.Artifact(Artifact{Name: "PR #7: Fix it", Kind: "pull_request", URL: "https://example.test/pr/7", Data: map[string]any{"number": 7.0}})
	ctx.Check(Check{Name: "tests", Status: CheckFail, Message: "2 failed", Subject: "suite", Evidence: map[string]any{"failed": 2.0}})
	ctx.Check(Check{Name: "bad", Status: "maybe"})
	if ctx.ParamString("fail", 0, "") != "" {
		return nil, ItemError(0, "after the records")
	}
	return [][]Item{ctx.InputData(0)}, nil
}

func TestRecords(t *testing.T) {
	p := NewPlugin(PluginInfo{ID: "rec", Name: "Rec", Version: "1"}, reporterNode{})
	resp, err := p.Execute(context.Background(), execReq("rec.reporter", nil))
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Records) != 2 {
		t.Fatalf("records = %+v", resp.Records)
	}
	a, c := resp.Records[0], resp.Records[1]
	if a.Type != "artifact" || a.Kind != "pull_request" || a.URL != "https://example.test/pr/7" || !strings.HasSuffix(a.At, "Z") {
		t.Errorf("artifact = %+v", a)
	}
	if c.Type != "check" || c.Status != CheckFail || c.Subject != "suite" {
		t.Errorf("check = %+v", c)
	}
	if len(resp.Logs) != 1 || !strings.Contains(resp.Logs[0].Message, "unknown status") {
		t.Errorf("logs = %+v", resp.Logs)
	}

	// JSON: the wire shape the host reads.
	data, _ := json.Marshal(resp)
	var wire map[string]any
	_ = json.Unmarshal(data, &wire)
	first := wire["records"].([]any)[0].(map[string]any)
	if first["type"] != "artifact" || first["mimeType"] != nil || first["name"] != "PR #7: Fix it" {
		t.Errorf("wire = %v", first)
	}

	// gRPC: survives the proto wire bytes.
	msg, err := executeResponseToProto(resp)
	if err != nil {
		t.Fatal(err)
	}
	bytes, _ := proto.Marshal(msg)
	var decoded pb.ExecuteResponse
	if err := proto.Unmarshal(bytes, &decoded); err != nil {
		t.Fatal(err)
	}
	back, err := ExecuteResponseFromProto(&decoded)
	if err != nil || !reflect.DeepEqual(back.Records, resp.Records) {
		t.Errorf("round trip = %+v (%v)", back.Records, err)
	}

	// Records made before a failure are kept; a node that reports none sends none.
	failed, _ := p.Execute(context.Background(), execReq("rec.reporter", map[string]any{"fail": "x"}))
	if failed.Error == nil || len(failed.Records) != 2 {
		t.Errorf("failed = %+v", failed)
	}
	quiet, _ := testPlugin().Execute(context.Background(), execReq("test-plugin.behave", nil))
	if quiet.Records != nil {
		t.Errorf("quiet records = %+v", quiet.Records)
	}
}
