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

// Only reads are idempotent: select (SQL) and get, info, keys, llen (Redis). Writes, executeQuery and pops stay at most once.
func TestMCPToolsAreIdempotent(t *testing.T) {
	tools := mcpTools(t)
	want := "mySql_select,postgres_select,redis_get,redis_info,redis_keys,redis_llen,sqlite_select"
	if got := names(tools, true); got != want {
		t.Fatalf("idempotent tools: %s", got)
	}
	for _, write := range []string{"postgres_executeQuery", "postgres_insert", "mySql_deleteTable", "sqlite_update", "redis_pop", "redis_set", "redis_publish"} {
		if hint, ok := tools[write]; !ok || hint {
			t.Errorf("%s: listed=%v idempotentHint=%v", write, ok, hint)
		}
	}
}

func TestNodesAreNotIdempotentAsAWhole(t *testing.T) {
	for _, n := range newPlugin().Manifest().Nodes {
		if n.Idempotent {
			t.Errorf("node %s mixes reads and writes: only its read operations may be idempotent", n.Name)
		}
	}
}
