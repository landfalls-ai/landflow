package landflow

import (
	"bufio"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// mcpServe runs Serve for a test and returns the HTTP port, the log buffer and a stop function.
func mcpServe(t *testing.T, opts ...ServeOption) (int, *syncBuffer, func()) {
	t.Helper()
	port := freePort(t)
	logs := &syncBuffer{}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- Serve(ctx, NewPlugin(PluginInfo{ID: "mcp-test", Name: "MCP", Version: "1.0.0"}, upperNode{}), append([]ServeOption{WithHTTP(port), WithRegistryURL("off"), WithLogger(log.New(logs, "", 0))}, opts...)...)
	}()
	waitFor(t, "http", func() bool {
		resp, err := http.Get("http://127.0.0.1:" + strconv.Itoa(port) + PathHealth)
		if err == nil {
			resp.Body.Close()
		}
		return err == nil
	})
	var once sync.Once
	return port, logs, func() {
		once.Do(func() {
			cancel()
			if err := <-done; err != nil {
				t.Errorf("serve: %v", err)
			}
		})
	}
}

func mcpStatus(t *testing.T, port int, token string) int {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, "http://127.0.0.1:"+strconv.Itoa(port)+PathMCP, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Mcp-Protocol-Version", "2026-07-28")
	req.Header.Set("Mcp-Method", "tools/list")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

func TestMCPFaceOnByDefaultOnLoopback(t *testing.T) {
	clearEnv(t)
	port, logs, stop := mcpServe(t)
	defer stop()
	if got := mcpStatus(t, port, ""); got != 200 {
		t.Fatalf("/mcp on loopback without a token: %d\nlogs:\n%s", got, logs.String())
	}
	resp, _ := http.Get("http://127.0.0.1:" + strconv.Itoa(port) + PathManifest)
	var m PluginManifest
	_ = json.NewDecoder(resp.Body).Decode(&m)
	resp.Body.Close()
	if strings.Join(m.Transports, ",") != "http,mcp" {
		t.Fatalf("transports %v", m.Transports)
	}
	if !strings.Contains(logs.String(), "MCP face at /mcp (loopback only, no token)") {
		t.Fatalf("logs:\n%s", logs.String())
	}
}

func TestMCPFaceNeedsTokenOffLoopback(t *testing.T) {
	clearEnv(t)
	t.Setenv("LANDFLOW_ADVERTISE_HOST", "127.0.0.1")
	t.Setenv("LANDFLOW_LISTEN_HOST", "0.0.0.0")
	port, logs, stop := mcpServe(t)
	defer stop()
	if got := mcpStatus(t, port, ""); got != 404 {
		t.Fatalf("/mcp must not be mounted without a token: %d", got)
	}
	if !strings.Contains(logs.String(), "MCP face not started: LANDFLOW_MCP_TOKEN is not set") {
		t.Fatalf("logs:\n%s", logs.String())
	}
	resp, _ := http.Get("http://127.0.0.1:" + strconv.Itoa(port) + PathManifest)
	var m PluginManifest
	_ = json.NewDecoder(resp.Body).Decode(&m)
	resp.Body.Close()
	if strings.Join(m.Transports, ",") != "http" {
		t.Fatalf("transports %v", m.Transports)
	}
	stop()

	t.Setenv("LANDFLOW_MCP_TOKEN", "tok")
	port, _, stop2 := mcpServe(t)
	defer stop2()
	if mcpStatus(t, port, "") != 401 || mcpStatus(t, port, "wrong") != 401 || mcpStatus(t, port, "tok") != 200 {
		t.Fatal("token check")
	}
}

func TestMCPFaceOff(t *testing.T) {
	clearEnv(t)
	t.Setenv("LANDFLOW_MCP", "off")
	port, _, stop := mcpServe(t)
	defer stop()
	if got := mcpStatus(t, port, ""); got != 404 {
		t.Fatalf("LANDFLOW_MCP=off: %d", got)
	}
	stop()
	t.Setenv("LANDFLOW_MCP", "")
	port, _, stop2 := mcpServe(t, WithoutMCP())
	defer stop2()
	if got := mcpStatus(t, port, ""); got != 404 {
		t.Fatalf("WithoutMCP: %d", got)
	}
	t.Setenv("LANDFLOW_MCP", "maybe")
	if err := Serve(context.Background(), NewPlugin(PluginInfo{ID: "x", Name: "X", Version: "1"}, upperNode{}), WithHTTP(freePort(t))); err == nil || !strings.Contains(err.Error(), "LANDFLOW_MCP") {
		t.Fatalf("invalid LANDFLOW_MCP: %v", err)
	}
}

// TestMCPStdio runs Serve in stdio mode (--mcp-stdio) with pipes in place of the process's stdin/stdout and speaks
// both eras on them; the real stdin/stdout path is the same code with StdioTransport (checked live with
// conformance/cmd/landflow-conformance-plugin --mcp-stdio).
// toolNode is upperNode flagged usableAsTool, so the face lists it.
type toolNode struct{ upperNode }

func (n toolNode) Description() NodeDescriptor {
	d := n.upperNode.Description()
	d.UsableAsTool = true
	return d
}

func TestMCPStdio(t *testing.T) {
	clearEnv(t)
	inR, inW, _ := os.Pipe()
	outR, outW, _ := os.Pipe()
	saved := mcpStdioTransport
	mcpStdioTransport = func() mcp.Transport { return &mcp.IOTransport{Reader: inR, Writer: outW} }
	t.Cleanup(func() { mcpStdioTransport = saved })
	logs := &syncBuffer{}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- Serve(ctx, NewPlugin(PluginInfo{ID: "stdio-test", Name: "Stdio", Version: "1.0.0"}, toolNode{}), WithHTTP(freePort(t)), WithRegistryURL("off"), WithLogger(log.New(logs, "", 0)), WithMCP(MCPOptions{Stdio: true}))
	}()
	reader := bufio.NewReaderSize(outR, 1<<20)
	ask := func(line string) map[string]any {
		t.Helper()
		if _, err := inW.Write([]byte(line + "\n")); err != nil {
			t.Fatal(err)
		}
		for {
			out, err := reader.ReadString('\n')
			if err != nil {
				t.Fatalf("read: %v\nlogs: %s", err, logs.String())
			}
			var msg map[string]any
			if json.Unmarshal([]byte(out), &msg) == nil && msg["id"] != nil {
				return msg
			}
		}
	}
	meta := `"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"t","version":"0"}}`
	discover := ask(`{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{` + meta + `}}`)
	if result, _ := discover["result"].(map[string]any); result == nil || result["supportedVersions"] == nil {
		t.Fatalf("discover: %v\nlogs: %s", discover, logs.String())
	}
	list := ask(`{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{` + meta + `}}`)
	if tools, _ := list["result"].(map[string]any)["tools"].([]any); len(tools) != 1 {
		t.Fatalf("tools/list: %v", list)
	}
	call := ask(`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"upper","arguments":{"field":"suffix","suffix":"!"},` + meta + `}}`)
	if sc, _ := call["result"].(map[string]any)["structuredContent"].(map[string]any); sc == nil || sc["items"].([]any)[0].(map[string]any)["suffix"] != "!!" {
		t.Fatalf("tools/call: %v", call)
	}
	// The 2025 handshake on the same wire: a fresh session per connection, so a second Serve answers initialize.
	if !strings.Contains(logs.String(), "speaking MCP on stdio") || strings.Contains(logs.String(), "metrics at") {
		t.Fatalf("stdio mode must not start HTTP; logs:\n%s", logs.String())
	}
	cancel()
	inW.Close()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serve: %v", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("Serve did not return after cancel")
	}
}
