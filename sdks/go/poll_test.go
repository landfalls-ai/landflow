package landflow

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	pb "github.com/landflow/landflow/sdks/go/landflowpb"
)

func TestPollIntervalProperty(t *testing.T) {
	p := PollIntervalProperty(0)
	if p.Name != "pollInterval" || p.Type != PropNumber || p.Default != 60 || *p.TypeOptions.MinValue != 10 {
		t.Errorf("default property = %+v", p)
	}
	if PollIntervalProperty(5).Default != 10 || PollIntervalProperty(300).Default != 300 {
		t.Error("default not clamped to the minimum")
	}
	// A poll trigger without the property gets it, and becomes kind trigger.
	d := credPlugin().nodes["feed"].descriptor
	if d.Kind != KindTrigger || len(d.Inputs) != 0 || !hasProperty(d.Properties, "pollInterval") {
		t.Errorf("poll descriptor = kind %s inputs %v props %v", d.Kind, d.Inputs, d.Properties)
	}
	// A declared non-number pollInterval is rejected.
	_, err := BuildPlugin(PluginInfo{ID: "x", Name: "X", Version: "1"}, nodeFunc{d: NodeDescriptor{
		Name: "t", DisplayName: "T", Kind: KindAction, TriggerSource: TriggerPoll,
		Properties: []PropertyDescriptor{{Name: "pollInterval", DisplayName: "P", Type: PropString}},
	}})
	if err == nil || !strings.Contains(err.Error(), "pollInterval must be a number") || !strings.Contains(err.Error(), "requires kind trigger") {
		t.Errorf("validation = %v", err)
	}
}

func pollReq(mode ExecutionMode, latest int, state map[string]any) *ExecuteRequest {
	return &ExecuteRequest{
		Protocol: ProtocolVersion, ExecutionID: "ex_p", WorkflowID: "wf_p", Mode: mode,
		Node:       NodeRef{ID: "n1", Name: "Feed", Type: "cred-plugin.feed", TypeVersion: 1},
		Parameters: map[string]any{"latest": latest}, Inputs: [][]Item{}, PollState: state,
	}
}

func TestPollStateRoundTripHTTP(t *testing.T) {
	srv := httptest.NewServer(credPlugin().Handler())
	defer srv.Close()
	run := func(req *ExecuteRequest) ExecuteResponse {
		code, body := postJSON(t, srv.URL+PathExecute, req, nil)
		if code != 200 {
			t.Fatalf("execute: %d %s", code, body)
		}
		var resp ExecuteResponse
		if err := json.Unmarshal(body, &resp); err != nil {
			t.Fatal(err)
		}
		return resp
	}

	// First poll: baseline, no items, state returned.
	first := run(pollReq(ModePoll, 3, nil))
	if len(first.Outputs) != 1 || len(first.Outputs[0]) != 0 || first.PollState["lastId"] != 3.0 {
		t.Fatalf("first poll = %+v", first)
	}
	// Next poll gets the state back and emits only new entries.
	second := run(pollReq(ModePoll, 5, first.PollState))
	if len(second.Outputs[0]) != 2 || second.Outputs[0][0].JSON["id"] != 4.0 || second.PollState["lastId"] != 5.0 {
		t.Fatalf("second poll = %+v", second)
	}
	// Nothing new: empty output, state kept.
	third := run(pollReq(ModePoll, 5, second.PollState))
	if len(third.Outputs[0]) != 0 || third.PollState["lastId"] != 5.0 {
		t.Fatalf("third poll = %+v", third)
	}
	// Manual mode: recent items, never a pollState.
	manual := run(pollReq(ModeManual, 5, nil))
	if len(manual.Outputs[0]) != 1 || manual.PollState != nil {
		t.Fatalf("manual = %+v", manual)
	}
}

func TestPollStateRoundTripGRPC(t *testing.T) {
	client := bufconnClient(t, credPlugin())
	run := func(req *ExecuteRequest) *ExecuteResponse {
		in, err := ExecuteRequestToProto(req)
		if err != nil {
			t.Fatal(err)
		}
		out, err := client.Execute(context.Background(), in)
		if err != nil {
			t.Fatal(err)
		}
		resp, err := ExecuteResponseFromProto(out)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}
	first := run(pollReq(ModePoll, 2, nil))
	if len(first.Outputs[0]) != 0 || first.PollState["lastId"] != 2.0 {
		t.Fatalf("first poll = %+v", first)
	}
	second := run(pollReq(ModePoll, 4, first.PollState))
	if len(second.Outputs[0]) != 2 || second.PollState["lastId"] != 4.0 {
		t.Fatalf("second poll = %+v", second)
	}
	// An explicit empty state is not a first poll; absent and null are.
	in, _ := ExecuteRequestToProto(pollReq(ModePoll, 1, map[string]any{}))
	if in.GetPollState() == nil {
		t.Error("empty pollState should be sent")
	}
	req, err := executeRequestFromProto(&pb.ExecuteRequest{PollState: &pb.DynamicValue{Json: []byte("null")}})
	if err != nil || req.PollState != nil {
		t.Errorf("null pollState = %v %v", req.PollState, err)
	}
	if ctx := NewExecuteContext(context.Background(), &ExecuteRequest{Mode: ModePoll, PollState: map[string]any{}}, nil); ctx.IsFirstPoll() {
		t.Error("empty state counted as first poll")
	}
	if ctx := NewExecuteContext(context.Background(), &ExecuteRequest{Mode: ModeManual}, nil); ctx.IsFirstPoll() {
		t.Error("manual mode counted as first poll")
	}
}
