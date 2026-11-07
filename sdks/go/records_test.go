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

type modelNode struct{}

func (modelNode) Description() NodeDescriptor {
	return NodeDescriptor{Name: "modeler", DisplayName: "Modeler", Description: "Calls a model", Version: V(1), MeterAiUsage: true}
}

func (modelNode) Execute(ctx *ExecuteContext) ([][]Item, error) {
	ctx.Model(ModelCall{Model: "qwen3.8:latest", Provider: "ollama", InputTokens: 20, OutputTokens: 0, CacheReadTokens: 16, DurationMs: 120,
		FinishReason: "stop", Prompt: "tell me", Answer: "ok", Name: "summarize"})
	ctx.Model(ModelCall{Model: "m", Provider: "ollama", InputTokens: -5, OutputTokens: 3})
	return [][]Item{ctx.InputData(0)}, nil
}

func TestModelRecords(t *testing.T) {
	p := NewPlugin(PluginInfo{ID: "mod", Name: "Mod", Version: "1"}, modelNode{})
	resp, err := p.Execute(context.Background(), execReq("mod.modeler", nil))
	if err != nil || len(resp.Records) != 2 {
		t.Fatalf("records = %+v (%v)", resp.Records, err)
	}
	data, _ := json.Marshal(resp.Records[0])
	var wire map[string]any
	_ = json.Unmarshal(data, &wire)
	want := map[string]any{"type": "model", "name": "summarize", "model": "qwen3.8:latest", "provider": "ollama", "inputTokens": 20.0, "outputTokens": 0.0,
		"cacheReadTokens": 16.0, "durationMs": 120.0, "finishReason": "stop", "prompt": "tell me", "answer": "ok"}
	for k, v := range want {
		if wire[k] != v {
			t.Errorf("wire[%s] = %v, want %v", k, wire[k], v)
		}
	}
	if _, ok := wire["cacheWriteTokens"]; ok {
		t.Errorf("zero cacheWriteTokens should be omitted: %v", wire)
	}
	if at, _ := wire["at"].(string); !strings.HasSuffix(at, "Z") {
		t.Errorf("at = %v", wire["at"])
	}
	// A negative count is sent as zero; with no name the key is absent.
	data, _ = json.Marshal(resp.Records[1])
	wire = nil
	_ = json.Unmarshal(data, &wire)
	if wire["inputTokens"] != 0.0 || wire["outputTokens"] != 3.0 {
		t.Errorf("clamped = %v", wire)
	}
	if _, ok := wire["name"]; ok {
		t.Errorf("empty name should be omitted: %v", wire)
	}

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

	desc, _ := json.Marshal(modelNode{}.Description())
	if !strings.Contains(string(desc), `"meterAiUsage":true`) {
		t.Errorf("descriptor = %s", desc)
	}
}
