package landflow

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestPairedItemFilling(t *testing.T) {
	p := testPlugin()

	// Same length as input 0 → pairedItem.item = i.
	resp, err := p.Execute(context.Background(), execReq("test-plugin.upper", map[string]any{}, map[string]any{"value": "a"}, map[string]any{"value": "b"}))
	if err != nil || resp.Error != nil {
		t.Fatalf("unexpected failure: %v %+v", err, resp.Error)
	}
	for i, it := range resp.Outputs[0] {
		if it.PairedItem == nil || it.PairedItem.Item != i {
			t.Errorf("item %d pairedItem = %+v", i, it.PairedItem)
		}
	}
	if resp.Outputs[0][1].JSON["value"] != "B" {
		t.Errorf("output = %+v", resp.Outputs[0])
	}

	// Different length → left alone (and nil JSON becomes {}).
	resp, _ = p.Execute(context.Background(), execReq("behave", map[string]any{"do": "generate"}, map[string]any{}))
	for _, it := range resp.Outputs[0] {
		if it.PairedItem != nil {
			t.Errorf("pairedItem must not be filled when lengths differ: %+v", it)
		}
		if it.JSON == nil {
			t.Error("nil JSON must be normalised to {}")
		}
	}

	// Existing pairedItem is preserved; missing one is filled.
	resp, _ = p.Execute(context.Background(), execReq("test-plugin.behave", map[string]any{"do": "explicitPair"}, map[string]any{}, map[string]any{}))
	if resp.Outputs[0][0].PairedItem.Item != 7 || resp.Outputs[0][1].PairedItem.Item != 1 {
		t.Errorf("pairedItem = %+v / %+v", resp.Outputs[0][0].PairedItem, resp.Outputs[0][1].PairedItem)
	}

	// nil outputs → one empty branch per main output.
	resp, _ = p.Execute(context.Background(), execReq("test-plugin.behave", map[string]any{"do": "nil"}))
	if len(resp.Outputs) != 1 || resp.Outputs[0] == nil || len(resp.Outputs[0]) != 0 {
		t.Errorf("outputs = %#v", resp.Outputs)
	}
}

func TestExecuteErrors(t *testing.T) {
	p := testPlugin()
	ctx := context.Background()

	resp, err := p.Execute(ctx, execReq("test-plugin.upper", map[string]any{}, map[string]any{"value": "ok"}, map[string]any{"value": 1.0}))
	if err != nil {
		t.Fatal(err)
	}
	if resp.Error == nil || resp.Error.ItemIndex == nil || *resp.Error.ItemIndex != 1 || resp.Error.Description != "check the input" {
		t.Fatalf("NodeError not mapped: %+v", resp.Error)
	}
	if resp.Outputs == nil || len(resp.Outputs) != 0 {
		t.Errorf("outputs on error must be []: %#v", resp.Outputs)
	}

	cases := map[string]string{
		"plain":          "plain failure",
		"nodeErrorValue": "by value",
		"wrapped":        "wrapped node error",
		"panic":          `panic in node "behave": boom`,
	}
	for do, want := range cases {
		resp, err := p.Execute(ctx, execReq("test-plugin.behave", map[string]any{"do": do}))
		if err != nil || resp.Error == nil || resp.Error.Message != want {
			t.Errorf("do=%s: err=%v error=%+v, want message %q", do, err, resp.Error, want)
		}
	}
	resp, _ = p.Execute(ctx, execReq("test-plugin.behave", map[string]any{"do": "wrapped"}))
	if resp.Error.ItemIndex == nil || *resp.Error.ItemIndex != 2 {
		t.Errorf("wrapped NodeError lost itemIndex: %+v", resp.Error)
	}

	if _, err := p.Execute(ctx, execReq("other-plugin.upper", nil)); !errors.Is(err, ErrUnknownNode) {
		t.Errorf("foreign prefix: %v", err)
	}
	if _, err := p.Execute(ctx, execReq("test-plugin.missing", nil)); !errors.Is(err, ErrUnknownNode) {
		t.Errorf("missing node: %v", err)
	}
	bad := execReq("test-plugin.upper", nil)
	bad.Protocol = "landflow.plugin/v0"
	if _, err := p.Execute(ctx, bad); !errors.Is(err, ErrBadRequest) {
		t.Errorf("bad protocol: %v", err)
	}
}

func TestManifestJSONShape(t *testing.T) {
	p := testPlugin()
	data, err := json.Marshal(p.Manifest())
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	if m["protocol"] != ProtocolVersion {
		t.Errorf("protocol = %v", m["protocol"])
	}
	plugin := m["plugin"].(map[string]any)
	if plugin["language"] != "go" || plugin["sdk"].(map[string]any)["name"] != "landflow-sdk-go" {
		t.Errorf("plugin = %v", plugin)
	}
	nodes := m["nodes"].([]any)
	upper := nodes[0].(map[string]any)
	if upper["version"] != 1.0 {
		t.Errorf("single version must marshal as a number, got %#v", upper["version"])
	}
	prop := upper["properties"].([]any)[2].(map[string]any)
	if prop["typeOptions"].(map[string]any)["loadOptionsMethod"] != "modes" {
		t.Errorf("typeOptions = %v", prop["typeOptions"])
	}
	if _, ok := prop["displayOptions"]; ok {
		t.Error("empty displayOptions must be omitted")
	}
	behave := nodes[1].(map[string]any)
	if v, ok := behave["version"].([]any); !ok || len(v) != 2 {
		t.Errorf("multi version must marshal as an array, got %#v", behave["version"])
	}
	if behave["kind"] != "action" {
		t.Errorf("kind default = %v", behave["kind"])
	}
	inputs, ok := behave["inputs"].([]any)
	if !ok || len(inputs) != 1 || inputs[0].(map[string]any)["type"] != "main" {
		t.Errorf("default inputs = %#v", behave["inputs"])
	}
	flag := behave["properties"].([]any)[1].(map[string]any)
	if d, ok := flag["default"]; !ok || d != false {
		t.Errorf("default:false must be kept, got %#v (present=%v)", d, ok)
	}
	for _, key := range []string{"usableAsTool", "toolDescription", "categories", "icon"} {
		if _, ok := behave[key]; ok {
			t.Errorf("%s should be omitted when empty", key)
		}
	}

	var v Version
	if err := json.Unmarshal([]byte("[1,2]"), &v); err != nil || len(v) != 2 {
		t.Errorf("Version unmarshal array: %v %v", v, err)
	}
	if err := json.Unmarshal([]byte("3"), &v); err != nil || len(v) != 1 || v[0] != 3 {
		t.Errorf("Version unmarshal number: %v %v", v, err)
	}
}

type badNode struct{ d NodeDescriptor }

func (b badNode) Description() NodeDescriptor             { return b.d }
func (badNode) Execute(*ExecuteContext) ([][]Item, error) { return nil, nil }

func TestValidation(t *testing.T) {
	_, err := BuildPlugin(PluginInfo{ID: "Bad_ID", Name: "", Version: ""},
		badNode{NodeDescriptor{Name: "1bad", Kind: "weird", Version: V(0),
			Inputs: []PortDescriptor{{Type: "nope"}},
			Properties: []PropertyDescriptor{
				{Name: "sel", DisplayName: "Sel", Type: PropOptions},
				{Name: "dyn", DisplayName: "Dyn", Type: PropOptions, TypeOptions: &TypeOptions{LoadOptionsMethod: "x"}},
				{Name: "", DisplayName: "x", Type: "bogus"},
			}}},
		upperNode{}, upperNode{},
	)
	if err == nil {
		t.Fatal("expected validation error")
	}
	for _, want := range []string{
		"lowercase kebab-case", "plugin name is required", "plugin version is required",
		"must be an identifier", "displayName is required", "must be a positive integer",
		`kind "weird"`, `inputs[0].type "nope"`, "needs options or typeOptions.loadOptionsMethod",
		"does not implement OptionsLoader", "name is required", `type "bogus"`, "duplicate node name",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("validation error missing %q:\n%s", want, err)
		}
	}

	defer func() {
		if recover() == nil {
			t.Error("NewPlugin must panic on invalid descriptors")
		}
	}()
	NewPlugin(PluginInfo{ID: "x", Name: "X", Version: "1"})
}

func TestLoadOptions(t *testing.T) {
	p := testPlugin()
	ctx := context.Background()
	resp, err := p.LoadOptions(ctx, &LoadOptionsRequest{NodeType: "upper", Method: "modes"})
	if err != nil || len(resp.Options) != 2 {
		t.Fatalf("LoadOptions = %+v, %v", resp, err)
	}
	if _, err := p.LoadOptions(ctx, &LoadOptionsRequest{NodeType: "test-plugin.upper", Method: "nope"}); !errors.Is(err, ErrBadRequest) {
		t.Errorf("unknown method: %v", err)
	}
	if _, err := p.LoadOptions(ctx, &LoadOptionsRequest{NodeType: "behave", Method: "x"}); !errors.Is(err, ErrNoOptionsLoader) {
		t.Errorf("no loader: %v", err)
	}
	if _, err := p.LoadOptions(ctx, &LoadOptionsRequest{NodeType: "ghost", Method: "x"}); !errors.Is(err, ErrUnknownNode) {
		t.Errorf("unknown node: %v", err)
	}
}
