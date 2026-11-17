package main

import (
	"context"
	"strings"
	"testing"

	landflow "github.com/landflow/landflow/sdks/go"
)

var credentials = map[string]any{"helloApi": map[string]any{"apiKey": "hello-123", "salutation": "Hello"}}

// run sends the request the host would send. No server and no network.
func run(t *testing.T, node string, req landflow.ExecuteRequest, items ...map[string]any) *landflow.ExecuteResponse {
	t.Helper()
	req.Protocol, req.ExecutionID = landflow.ProtocolVersion, "ex_test"
	if req.Mode == "" {
		req.Mode = landflow.ModeManual
	}
	req.Node = landflow.NodeRef{ID: "n1", Name: "N", Type: "hello-node." + node, TypeVersion: 1}
	if req.Credentials == nil {
		req.Credentials = credentials
	}
	req.Inputs = [][]landflow.Item{{}}
	for _, it := range items {
		req.Inputs[0] = append(req.Inputs[0], landflow.Item{JSON: it})
		req.ItemParameters = append(req.ItemParameters, req.Parameters)
	}
	resp, err := newPlugin().Execute(context.Background(), &req)
	if err != nil {
		t.Fatalf("%s: %v", node, err)
	}
	return resp
}

func TestGreetSendsGreetingsToOutput0AndEmptyNamesToOutput1(t *testing.T) {
	resp := run(t, "greet", landflow.ExecuteRequest{Parameters: map[string]any{"name": "Ada"}}, map[string]any{"id": 1})
	if resp.Error != nil || len(resp.Outputs[0]) != 1 || len(resp.Outputs[1]) != 0 {
		t.Fatalf("response = %+v", resp)
	}
	if got := resp.Outputs[0][0].JSON; got["greeting"] != "Hello, Ada!" || got["id"] != 1 {
		t.Errorf("output 0 = %v", got)
	}

	empty := run(t, "greet", landflow.ExecuteRequest{Parameters: map[string]any{"name": "  "}}, map[string]any{"id": 2})
	if len(empty.Outputs[0]) != 0 || empty.Outputs[1][0].JSON["reason"] != "empty name" {
		t.Errorf("empty = %+v", empty.Outputs)
	}
}

func TestGreetShoutsAndUsesTheSalutation(t *testing.T) {
	resp := run(t, "greet", landflow.ExecuteRequest{
		Parameters:  map[string]any{"name": "Ada", "shout": true},
		Credentials: map[string]any{"helloApi": map[string]any{"apiKey": "hello-1", "salutation": "Hi"}},
	}, map[string]any{})
	if got := resp.Outputs[0][0].JSON["greeting"]; got != "HI, ADA!" {
		t.Errorf("greeting = %v", got)
	}
}

func TestGreetLongNameFailsTheStepWithTheItemIndex(t *testing.T) {
	resp := run(t, "greet", landflow.ExecuteRequest{Parameters: map[string]any{"name": strings.Repeat("x", 51)}}, map[string]any{})
	if resp.Error == nil || !strings.Contains(resp.Error.Message, "longer than 50") || resp.Error.ItemIndex == nil || *resp.Error.ItemIndex != 0 {
		t.Errorf("error = %+v", resp.Error)
	}
}

func TestGreetContinueOnFailSendsTheItemToSkipped(t *testing.T) {
	resp := run(t, "greet", landflow.ExecuteRequest{Parameters: map[string]any{"name": strings.Repeat("x", 51)}, ContinueOnFail: true}, map[string]any{})
	if resp.Error != nil {
		t.Fatalf("error = %+v", resp.Error)
	}
	if msg, _ := resp.Outputs[1][0].JSON["error"].(string); !strings.Contains(msg, "longer than 50") {
		t.Errorf("skipped = %v", resp.Outputs[1])
	}
}

func TestGreetRefusesToRunWithoutTheCredential(t *testing.T) {
	resp := run(t, "greet", landflow.ExecuteRequest{Parameters: map[string]any{"name": "Ada"}, Credentials: map[string]any{}}, map[string]any{})
	if resp.Error == nil || !strings.Contains(resp.Error.Message, "helloApi") {
		t.Errorf("error = %+v", resp.Error)
	}
}

func TestCredentialTest(t *testing.T) {
	p := newPlugin()
	ok, err := p.TestCredentials(context.Background(), &landflow.TestCredentialsRequest{CredentialType: "helloApi", Data: map[string]any{"apiKey": "hello-1"}})
	if err != nil || !ok.OK || ok.Message != "Key accepted" {
		t.Errorf("accepted = %+v, %v", ok, err)
	}
	bad, _ := p.TestCredentials(context.Background(), &landflow.TestCredentialsRequest{CredentialType: "helloApi", Data: map[string]any{"apiKey": "nope"}})
	if bad.OK {
		t.Error("a key of the wrong shape was accepted")
	}
}

func TestNewRequestRecordsABaselineThenReturnsOnlyWhatIsNew(t *testing.T) {
	feed.requests = nil
	pushRequest(1, "old")
	first := run(t, "newRequest", landflow.ExecuteRequest{Mode: landflow.ModePoll})
	if len(first.Outputs) != 0 && len(first.Outputs[0]) != 0 {
		t.Errorf("the baseline poll emitted %v", first.Outputs)
	}
	if first.PollState["lastId"] != 1 {
		t.Fatalf("pollState = %v", first.PollState)
	}

	pushRequest(2, "new")
	second := run(t, "newRequest", landflow.ExecuteRequest{Mode: landflow.ModePoll, PollState: first.PollState})
	if len(second.Outputs[0]) != 1 || second.Outputs[0][0].JSON["name"] != "new" || second.PollState["lastId"] != 2 {
		t.Errorf("second = %+v", second)
	}
}

func TestNewRequestShowsRecentItemsInManualModeWithoutState(t *testing.T) {
	feed.requests = nil
	pushRequest(1, "a")
	resp := run(t, "newRequest", landflow.ExecuteRequest{Mode: landflow.ModeManual})
	if len(resp.Outputs[0]) != 1 || resp.PollState != nil {
		t.Errorf("response = %+v", resp)
	}
}

func TestManifest(t *testing.T) {
	m := newPlugin().Manifest()
	if m.Plugin.ID != "hello-node" || m.Plugin.Language != "go" || len(m.Nodes) != 2 || len(m.Nodes[0].Outputs) != 2 {
		t.Errorf("manifest = %+v", m)
	}
	if len(m.CredentialTypes) != 1 || !m.CredentialTypes[0].Testable {
		t.Errorf("credential types = %+v", m.CredentialTypes)
	}
}
