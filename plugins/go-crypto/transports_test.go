package main

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"testing"

	"github.com/landflow/landflow/sdks/go/mcpface"
	"github.com/landflow/landflow/sdks/go/transport"
)

// mcpTools lists the plugin's tools the way its MCP face does (tools/list), with each tool's idempotentHint.
func mcpTools(t *testing.T) map[string]bool {
	t.Helper()
	dispatch := func(context.Context, transport.Method, json.RawMessage, transport.DispatchContext) (any, error) {
		return nil, nil
	}
	face, err := mcpface.New(newPlugin().Manifest(), dispatch, mcpface.FaceOptions{Credentials: mcpface.Credentials{}})
	if err != nil {
		t.Fatal(err)
	}
	tools := map[string]bool{}
	for _, tool := range face.Tools() {
		hint := false
		if tool.Annotations != nil {
			hint = tool.Annotations.IdempotentHint
		}
		tools[tool.Name] = hint
	}
	return tools
}

func names(m map[string]bool, want bool) string {
	var out []string
	for name, v := range m {
		if v == want {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return strings.Join(out, ",")
}

// Every go-crypto node is a pure transform, so each one may be delivered twice by a broker.
func TestNodesAreIdempotent(t *testing.T) {
	m := newPlugin().Manifest()
	if len(m.Nodes) != 4 {
		t.Fatalf("%d nodes", len(m.Nodes))
	}
	for _, n := range m.Nodes {
		if !n.Idempotent {
			t.Errorf("node %s must be idempotent", n.Name)
		}
	}
}

func TestMCPToolsAreIdempotent(t *testing.T) {
	tools := mcpTools(t)
	if got := names(tools, true); got != "hash,jwtDecode,uuid" {
		t.Fatalf("idempotent tools: %s", got)
	}
	if got := names(tools, false); got != "" {
		t.Fatalf("tools without the hint: %s", got)
	}
}
