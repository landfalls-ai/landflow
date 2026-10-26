package mcpface

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/landflow/landflow/sdks/go/transport"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// fakeDispatch answers Execute like the conformance plugin's echo node and records what it got.
type fakeDispatch struct {
	calls []json.RawMessage
}

func (f *fakeDispatch) dispatch(ctx context.Context, method transport.Method, body json.RawMessage, dc transport.DispatchContext) (any, error) {
	f.calls = append(f.calls, body)
	var req struct {
		Node       struct{ Type string }
		Parameters map[string]any
		Inputs     [][]map[string]any
	}
	_ = json.Unmarshal(body, &req)
	if method == transport.MethodLoadOptions {
		return map[string]any{"options": []map[string]any{{"name": "A", "value": "a"}}}, nil
	}
	if req.Parameters["message"] == "boom" {
		return map[string]any{"outputs": [][]any{}, "error": map[string]any{"message": "boom", "description": "asked to fail"}}, nil
	}
	if req.Parameters["message"] == "slow" {
		<-ctx.Done()
		return nil, &transport.DispatchError{Code: transport.CodeCancelled, Message: ctx.Err().Error()}
	}
	if req.Node.Type == "landflow-conformance.nope" {
		return nil, &transport.DispatchError{Code: transport.CodeNotFound, Message: "unknown node type"}
	}
	return map[string]any{"outputs": [][]map[string]any{{{"json": map[string]any{"echo": req.Parameters["message"], "tool": ToolNameOf(ctx)}}}}}, nil
}

func conformanceManifest(t *testing.T) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(conformanceDir(t), "plugin-manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestFaceOverBothErasAndStdio(t *testing.T) {
	fake := &fakeDispatch{}
	face, err := New(conformanceManifest(t), fake.dispatch, FaceOptions{Token: "secret", Credentials: Credentials{}})
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, tool := range face.Tools() {
		names = append(names, tool.Name)
	}
	if strings.Join(names, ",") != "echo,sleep,fail,payload,counter" {
		t.Fatalf("tools %v", names)
	}
	srv := httptest.NewServer(face.Handler())
	defer srv.Close()

	// No token: 401 with the challenge.
	resp, err := http.Post(srv.URL, "application/json", strings.NewReader(`{}`))
	if err != nil || resp.StatusCode != 401 || !strings.HasPrefix(resp.Header.Get("WWW-Authenticate"), "Bearer realm=") {
		t.Fatalf("no token: %v %v", resp.StatusCode, err)
	}

	for _, version := range []string{"2026-07-28", "2025-11-25"} {
		t.Run(version, func(t *testing.T) {
			client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "0"}, nil)
			rt := &bearerTransport{token: "secret"}
			session, err := client.Connect(context.Background(), &mcp.StreamableClientTransport{Endpoint: srv.URL, HTTPClient: &http.Client{Transport: rt}}, &mcp.ClientSessionOptions{ProtocolVersion: version})
			if err != nil {
				t.Fatal(err)
			}
			defer session.Close()
			if got := session.InitializeResult().ProtocolVersion; got != version {
				t.Fatalf("negotiated %s, want %s", got, version)
			}
			list, err := session.ListTools(context.Background(), nil)
			if err != nil || len(list.Tools) != 5 || list.Tools[0].Name != "echo" {
				t.Fatalf("list: %v %v", list, err)
			}
			res, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: "echo", Arguments: map[string]any{"message": "hi", "extra": 1}})
			if err != nil {
				t.Fatal(err)
			}
			items := res.StructuredContent.(map[string]any)["items"].([]any)
			first := items[0].(map[string]any)
			text := res.Content[0].(*mcp.TextContent).Text
			if res.IsError || first["echo"] != "hi" || first["tool"] != "echo" || !strings.Contains(text, "passed only as input item fields: extra") {
				t.Fatalf("call: %+v %q", res, text)
			}
			res, err = session.CallTool(context.Background(), &mcp.CallToolParams{Name: "echo", Arguments: map[string]any{"message": "boom"}})
			if err != nil || !res.IsError || res.Content[0].(*mcp.TextContent).Text != "boom\nasked to fail" {
				t.Fatalf("node error: %+v %v", res, err)
			}
			if _, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: "nope"}); err == nil || !strings.Contains(strings.ToLower(err.Error()), "unknown tool") {
				t.Fatalf("unknown tool: %v", err)
			}
		})
	}

	// The request the dispatcher saw: mode mcp, parameters and the input item.
	var last struct {
		Mode       string
		Node       struct{ Type string }
		Parameters map[string]any
	}
	_ = json.Unmarshal(fake.calls[0], &last)
	if last.Mode != "mcp" || last.Node.Type != "landflow-conformance.echo" || last.Parameters["message"] != "hi" {
		t.Fatalf("request %+v", last)
	}

	// Raw 2026-07-28 wire, as the TS runner sends it: JSON in, JSON out with resultType.
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"x","version":"1"}}}}`
	req, _ := http.NewRequest("POST", srv.URL, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Authorization", "Bearer secret")
	req.Header.Set("Mcp-Protocol-Version", "2026-07-28")
	req.Header.Set("Mcp-Method", "tools/list")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(resp.Body)
	var decoded struct {
		Result struct {
			ResultType string `json:"resultType"`
			CacheScope string `json:"cacheScope"`
			Tools      []struct{ Name string }
		}
	}
	if err := json.Unmarshal(raw, &decoded); err != nil || resp.StatusCode != 200 || decoded.Result.ResultType != "complete" || decoded.Result.CacheScope != "private" || len(decoded.Result.Tools) != 5 {
		t.Fatalf("modern wire: %d %s", resp.StatusCode, raw)
	}

	// Closing the request stream cancels the call.
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	call := strings.NewReader(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"echo","arguments":{"message":"slow"},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}`)
	req, _ = http.NewRequestWithContext(ctx, "POST", srv.URL, call)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Authorization", "Bearer secret")
	req.Header.Set("Mcp-Protocol-Version", "2026-07-28")
	req.Header.Set("Mcp-Method", "tools/call")
	req.Header.Set("Mcp-Name", "echo")
	if _, err := http.DefaultClient.Do(req); err == nil {
		t.Fatal("expected the cancelled request to fail")
	}

	// stdio-style: a session over in-memory transports (what --mcp-stdio does on stdin/stdout).
	ct, st := mcp.NewInMemoryTransports()
	go func() { _ = face.ServeTransport(context.Background(), st) }()
	session, err := mcp.NewClient(&mcp.Implementation{Name: "t", Version: "0"}, nil).Connect(context.Background(), ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	list, err := session.ListTools(context.Background(), nil)
	if err != nil || len(list.Tools) != 5 {
		t.Fatalf("stdio list %v %v", list, err)
	}
}

func TestFaceCredentialsAndListOptions(t *testing.T) {
	manifest := map[string]any{
		"protocol": "landflow.plugin/v1", "plugin": map[string]any{"id": "p", "name": "P", "version": "1"},
		"credentialTypes": []any{map[string]any{"name": "pApi", "displayName": "P", "properties": []any{map[string]any{"name": "token", "displayName": "T", "type": "string"}}}},
		"nodes": []any{map[string]any{
			"name": "n", "displayName": "N", "description": "", "version": 1, "kind": "action", "usableAsTool": true,
			"inputs": []any{map[string]any{"type": "main"}}, "outputs": []any{map[string]any{"type": "main"}},
			"credentials": []any{map[string]any{"name": "pApi", "required": true, "displayOptions": map[string]any{"show": map[string]any{"authentication": []any{"token"}}}}},
			"properties": []any{
				map[string]any{"name": "authentication", "displayName": "Auth", "type": "options", "default": "token", "options": []any{map[string]any{"name": "Token", "value": "token"}}},
				map[string]any{"name": "channel", "displayName": "Channel", "type": "options", "default": "", "typeOptions": map[string]any{"loadOptionsMethod": "channels"}},
			},
		}},
	}
	fake := &fakeDispatch{}
	face, err := New(manifest, fake.dispatch, FaceOptions{Loopback: true, Credentials: Credentials{}})
	if err != nil {
		t.Fatal(err)
	}
	if len(face.Tools()) != 1 {
		t.Fatalf("no credential: no list_options tool, got %d", len(face.Tools()))
	}
	ct, st := mcp.NewInMemoryTransports()
	go func() { _ = face.ServeTransport(context.Background(), st) }()
	session, _ := mcp.NewClient(&mcp.Implementation{Name: "t", Version: "0"}, nil).Connect(context.Background(), ct, nil)
	res, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: "n"})
	if err != nil || !res.IsError || !strings.Contains(res.Content[0].(*mcp.TextContent).Text, "pApi (fields: token)") {
		t.Fatalf("missing credential: %+v %v", res, err)
	}
	session.Close()

	face, _ = New(manifest, fake.dispatch, FaceOptions{Loopback: true, Credentials: Credentials{"pApi": {"token": "t"}}})
	if len(face.Tools()) != 2 || face.Tools()[1].Name != ListOptionsTool {
		t.Fatalf("with a credential: %d tools", len(face.Tools()))
	}
	ct, st = mcp.NewInMemoryTransports()
	go func() { _ = face.ServeTransport(context.Background(), st) }()
	session, _ = mcp.NewClient(&mcp.Implementation{Name: "t", Version: "0"}, nil).Connect(context.Background(), ct, nil)
	defer session.Close()
	res, err = session.CallTool(context.Background(), &mcp.CallToolParams{Name: ListOptionsTool, Arguments: map[string]any{"tool": "n", "parameter": "channel"}})
	if err != nil || res.IsError || !strings.Contains(res.Content[0].(*mcp.TextContent).Text, "1 option") {
		t.Fatalf("list_options: %+v %v", res, err)
	}
	var sent struct {
		Credentials map[string]any
		Parameters  map[string]any
	}
	_ = json.Unmarshal(fake.calls[len(fake.calls)-1], &sent)
	if sent.Credentials["pApi"] == nil || sent.Parameters["authentication"] != "token" {
		t.Fatalf("bound credential and selector: %+v", sent)
	}
	res, _ = session.CallTool(context.Background(), &mcp.CallToolParams{Name: "n", Arguments: map[string]any{"channel": "c"}})
	_ = json.Unmarshal(fake.calls[len(fake.calls)-1], &sent)
	if res.IsError || sent.Credentials["pApi"] == nil || sent.Parameters["authentication"] != "token" || sent.Parameters["channel"] != "c" {
		t.Fatalf("execute with credential: %+v %+v", res, sent)
	}
}

func TestEnvHelpers(t *testing.T) {
	if m, _ := ModeFromEnv("", map[string]string{}, []string{"--mcp-stdio"}); m != ModeStdio {
		t.Fatal("flag")
	}
	if m, _ := ModeFromEnv(ModeOff, map[string]string{ModeEnv: "on"}, []string{}); m != ModeOff {
		t.Fatal("on only means not off; code may still turn the face off (as in TypeScript)")
	}
	if m, _ := ModeFromEnv(ModeOff, map[string]string{ModeEnv: "stdio"}, []string{}); m != ModeStdio {
		t.Fatal("stdio beats code")
	}
	if m, _ := ModeFromEnv("", map[string]string{ModeEnv: "off"}, []string{}); m != ModeOff {
		t.Fatal("off")
	}
	if _, err := ModeFromEnv("", map[string]string{ModeEnv: "maybe"}, []string{}); err == nil {
		t.Fatal("invalid value")
	}
	for host, want := range map[string]bool{"127.0.0.1": true, "localhost": true, "::1": true, "[::1]": true, "127.1.2.3": true, "0.0.0.0": false, "": false, "10.0.0.1": false} {
		if IsLoopbackHost(host) != want {
			t.Errorf("IsLoopbackHost(%q) != %v", host, want)
		}
	}
	creds, err := LoadCredentials(`{"plugin.fooApi": {"token": "t"}}`)
	if err != nil || creds["fooApi"]["token"] != "t" {
		t.Fatalf("inline creds %v %v", creds, err)
	}
	file := filepath.Join(t.TempDir(), "c.json")
	_ = os.WriteFile(file, []byte(`{"barApi": {"k": 1}}`), 0o600)
	if creds, err = LoadCredentials(file); err != nil || creds["barApi"]["k"] != float64(1) {
		t.Fatalf("file creds %v %v", creds, err)
	}
	if _, err := LoadCredentials(`[1]`); err == nil {
		t.Fatal("array must fail")
	}
	if !BearerTokenMatches("Bearer abc", "abc") || BearerTokenMatches("Bearer abd", "abc") || BearerTokenMatches("", "abc") || BearerTokenMatches("Bearer ", "") {
		t.Fatal("bearer")
	}
}

// bearerTransport adds the token to every request.
type bearerTransport struct{ token string }

func (b *bearerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r.Header.Set("Authorization", "Bearer "+b.token)
	return http.DefaultTransport.RoundTrip(r)
}

var _ = bytes.NewReader
