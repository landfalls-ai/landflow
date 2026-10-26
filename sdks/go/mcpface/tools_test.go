package mcpface

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"testing"
)

// conformanceDir is packages/protocol/conformance, the kit every SDK shares.
func conformanceDir(t *testing.T) string {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	dir := filepath.Join(filepath.Dir(file), "..", "..", "..", "packages", "protocol", "conformance")
	if _, err := os.Stat(filepath.Join(dir, "plugin-manifest.json")); err != nil {
		t.Skipf("conformance kit not found at %s: %v", dir, err)
	}
	return dir
}

type mcpToolsFixture struct {
	Cases []struct {
		ID       string          `json:"id"`
		Manifest json.RawMessage `json:"manifest"`
		Tools    json.RawMessage `json:"tools"`
	} `json:"cases"`
}

// roundTrip normalises a value to what json.Unmarshal into `any` gives, so two encodings compare structurally.
func roundTrip(t *testing.T, v any) any {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestToolsMatchConformanceFixture(t *testing.T) {
	data, err := os.ReadFile(filepath.Join(conformanceDir(t), "fixtures", "mcp-tools.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture mcpToolsFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Cases) < 4 {
		t.Fatalf("expected at least 4 fixture cases, got %d", len(fixture.Cases))
	}
	for _, c := range fixture.Cases {
		t.Run(c.ID, func(t *testing.T) {
			tools, err := ToolsFromManifest(c.Manifest)
			if err != nil {
				t.Fatal(err)
			}
			var expected []any
			if err := json.Unmarshal(c.Tools, &expected); err != nil {
				t.Fatal(err)
			}
			got := roundTrip(t, tools).([]any)
			if len(got) != len(expected) {
				t.Fatalf("got %d tools, fixture has %d", len(got), len(expected))
			}
			for i := range expected {
				if !reflect.DeepEqual(got[i], expected[i]) {
					g, _ := json.MarshalIndent(got[i], "", "  ")
					e, _ := json.MarshalIndent(expected[i], "", "  ")
					t.Errorf("tool %d differs\n--- got ---\n%s\n--- fixture ---\n%s", i, g, e)
				}
			}
		})
	}
}

func TestSanitizeAndGatewayNames(t *testing.T) {
	cases := map[string]string{
		"message_send": "message_send", "a.b": "a_b", "__x__": "x", "": "tool", "hello world!!": "hello_world",
		"a___b": "a_b", "-lead": "lead",
	}
	for in, want := range cases {
		if got := SanitizeToolName(in); got != want {
			t.Errorf("SanitizeToolName(%q) = %q, want %q", in, got, want)
		}
	}
	long := SanitizeToolName("aVeryLongNodeNameThatGoesOnAndOnAndOnToTestTheLimitOnToolNamesInTheMapping_and_more")
	if len(long) != 64 || !IsValidToolName(long) {
		t.Errorf("long name not cut to 64: %q (%d)", long, len(long))
	}
	if got := GatewayToolName("twilio", "message_send"); got != "twilio_message_send" {
		t.Errorf("gateway name %q", got)
	}
	if got := GatewayTargetName("My_Plugin"); !regexp.MustCompile(`^my-plugin-0ade9a$`).MatchString(got) {
		t.Errorf("gateway target %q", got)
	}
	if got := GatewayTargetName("text-toolkit"); got != "text-toolkit" {
		t.Errorf("gateway target %q", got)
	}
	if got := uniqueNames([]string{"a", "a", "a_2", "a"}); !reflect.DeepEqual(got, []string{"a", "a_3", "a_2", "a_4"}) {
		t.Errorf("uniqueNames %v", got)
	}
}

func TestToolCallToParameters(t *testing.T) {
	tools, err := ToolsFromManifest(map[string]any{
		"protocol": "landflow.plugin/v1", "plugin": map[string]any{"id": "p", "name": "P", "version": "1"},
		"nodes": []any{map[string]any{
			"name": "n", "displayName": "N", "description": "", "version": 1, "kind": "action", "usableAsTool": true,
			"inputs": []any{map[string]any{"type": "main"}}, "outputs": []any{map[string]any{"type": "main"}},
			"properties": []any{
				map[string]any{"name": "operation", "displayName": "Op", "type": "options", "default": "get", "options": []any{map[string]any{"name": "Get", "value": "get"}}},
				map[string]any{"name": "id", "displayName": "ID", "type": "string", "default": ""},
			},
		}},
	})
	if err != nil || len(tools) != 1 || tools[0].Name != "n_get" {
		t.Fatalf("tools %v %v", tools, err)
	}
	m := ToolCallToParameters(tools[0], map[string]any{"id": "7", "bogus": true, "operation": "delete"})
	if m.NodeType != "p.n" || m.TypeVersion != 1 || m.Parameters["operation"] != "get" || m.Parameters["id"] != "7" || !reflect.DeepEqual(m.Ignored, []string{"bogus", "operation"}) {
		t.Fatalf("mapping %+v", m)
	}
	listed := tools[0].WithoutBinding()
	if _, has := listed["_meta"]; has || listed["name"] != "n_get" {
		t.Fatalf("WithoutBinding %v", listed)
	}
}
