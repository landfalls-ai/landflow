package bridge_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/landflow/landflow/services/landflow-bridge/bridge"
	"github.com/landflow/landflow/services/landflow-bridge/internal/kit"
)

// The bridge's MCP face (sdks/go/mcpface): tools/list is the manifest's mapping, tools/call runs Execute on the plugin
// behind the bridge, on loopback without a token; port 7455.
func TestMCPFace(t *testing.T) {
	gp, stop, err := kit.ServeGoPlugin(context.Background(), goHTTPPort, goGRPCPort)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	b, _, _ := startBridge(t, newBroker(), "grpc://127.0.0.1:7441", func(c *bridge.Config) {
		c.MCP = bridge.MCPConfig{Mode: "on", Host: "127.0.0.1", Port: 7455}
	})
	if b.MCPAddr() == "" {
		t.Fatal("MCP face not started")
	}
	rpc := func(method string, params any) map[string]any {
		body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
		req, _ := http.NewRequest(http.MethodPost, "http://"+b.MCPAddr()+"/mcp", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		req.Header.Set("MCP-Protocol-Version", "2025-11-25")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		data, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s: HTTP %d %s", method, resp.StatusCode, data)
		}
		text := string(data)
		if i := strings.Index(text, "data:"); i >= 0 {
			text = strings.TrimSpace(strings.SplitN(text[i+5:], "\n", 2)[0])
		}
		var out map[string]any
		if err := json.Unmarshal([]byte(text), &out); err != nil {
			t.Fatalf("%s: %s", method, data)
		}
		return out
	}
	list := rpc("tools/list", map[string]any{})
	tools, _ := list["result"].(map[string]any)["tools"].([]any)
	var names []string
	for _, tool := range tools {
		names = append(names, tool.(map[string]any)["name"].(string))
	}
	if strings.Join(names, ",") != "echo,sleep,fail,payload,counter" {
		t.Fatalf("tools %v", names)
	}
	call := rpc("tools/call", map[string]any{"name": "echo", "arguments": map[string]any{"message": "hi"}})
	result, _ := call["result"].(map[string]any)
	if result == nil || result["isError"] == true {
		t.Fatalf("tools/call: %v", call)
	}
	if gp.Hooks.ByNode("echo") != 1 {
		t.Fatalf("echo ran %d times", gp.Hooks.ByNode("echo"))
	}
	if !strings.Contains(string(mustJSON(result)), `"echo":"hi"`) {
		t.Fatalf("result %s", mustJSON(result))
	}
}

func mustJSON(v any) []byte {
	data, _ := json.Marshal(v)
	return data
}
