package landflow

import (
	"bytes"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func doJSON(t *testing.T, srv *httptest.Server, method, path, body string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("%s %s: content-type %q", method, path, ct)
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatalf("%s %s: invalid JSON %q", method, path, data)
	}
	return resp.StatusCode, out
}

func TestHTTPHandler(t *testing.T) {
	srv := httptest.NewServer(testPlugin().Handler())
	defer srv.Close()

	code, wk := doJSON(t, srv, http.MethodGet, PathWellKnown, "")
	if code != 200 || wk["protocol"] != ProtocolVersion || wk["endpoints"].(map[string]any)["loadOptions"] != PathLoadOptions {
		t.Errorf("well-known: %d %v", code, wk)
	}
	if wk["plugin"].(map[string]any)["id"] != "test-plugin" {
		t.Errorf("well-known plugin: %v", wk["plugin"])
	}

	code, m := doJSON(t, srv, http.MethodGet, PathManifest, "")
	if code != 200 || len(m["nodes"].([]any)) != 2 {
		t.Errorf("manifest: %d %v", code, m)
	}

	code, h := doJSON(t, srv, http.MethodGet, PathHealth, "")
	if code != 200 || h["status"] != "ok" || h["pluginId"] != "test-plugin" || h["version"] != "1.2.3" {
		t.Errorf("health: %d %v", code, h)
	}
	if _, ok := h["uptimeMs"].(float64); !ok {
		t.Errorf("uptimeMs missing: %v", h)
	}

	body, _ := json.Marshal(execReq("test-plugin.upper", map[string]any{"suffix": "?"}, map[string]any{"value": "hi"}))
	code, ex := doJSON(t, srv, http.MethodPost, PathExecute, string(body))
	if code != 200 {
		t.Fatalf("execute: %d %v", code, ex)
	}
	item := ex["outputs"].([]any)[0].([]any)[0].(map[string]any)
	if item["json"].(map[string]any)["value"] != "HI?" || item["pairedItem"].(map[string]any)["item"] != 0.0 {
		t.Errorf("execute item: %v", item)
	}
	if logs := ex["logs"].([]any); logs[0].(map[string]any)["message"] != "processed 1 item(s)" {
		t.Errorf("logs: %v", logs)
	}
	if _, ok := ex["error"]; ok {
		t.Errorf("error must be absent on success: %v", ex)
	}

	// Node failure → 200 + error.
	body, _ = json.Marshal(execReq("test-plugin.behave", map[string]any{"do": "panic"}))
	code, ex = doJSON(t, srv, http.MethodPost, PathExecute, string(body))
	if code != 200 || ex["error"].(map[string]any)["message"] != `panic in node "behave": boom` {
		t.Errorf("panic: %d %v", code, ex)
	}
	if outs, ok := ex["outputs"].([]any); !ok || len(outs) != 0 {
		t.Errorf("outputs on failure: %v", ex["outputs"])
	}

	// Malformed → 400, unknown → 404, wrong method → 405.
	if code, out := doJSON(t, srv, http.MethodPost, PathExecute, `{"node":`); code != 400 || out["error"] == nil {
		t.Errorf("malformed: %d %v", code, out)
	}
	if code, _ := doJSON(t, srv, http.MethodPost, PathExecute, ``); code != 400 {
		t.Errorf("empty body: %d", code)
	}
	if code, _ := doJSON(t, srv, http.MethodPost, PathExecute, `{"protocol":"landflow.plugin/v1","node":{}}`); code != 400 {
		t.Errorf("missing node.type: %d", code)
	}
	if code, _ := doJSON(t, srv, http.MethodPost, PathExecute, `{"inputs": "nope", "node":{"type":"test-plugin.upper"}}`); code != 400 {
		t.Errorf("wrong field type: %d", code)
	}
	body, _ = json.Marshal(execReq("test-plugin.ghost", nil))
	if code, out := doJSON(t, srv, http.MethodPost, PathExecute, string(body)); code != 404 || !strings.Contains(out["error"].(map[string]any)["message"].(string), "unknown node type") {
		t.Errorf("unknown node: %d %v", code, out)
	}
	if code, _ := doJSON(t, srv, http.MethodGet, PathExecute, ""); code != 405 {
		t.Errorf("GET execute: %d", code)
	}

	// Load options.
	code, lo := doJSON(t, srv, http.MethodPost, PathLoadOptions, `{"nodeType":"upper","method":"modes","parameters":{}}`)
	if code != 200 || len(lo["options"].([]any)) != 2 {
		t.Errorf("load-options: %d %v", code, lo)
	}
	if code, _ := doJSON(t, srv, http.MethodPost, PathLoadOptions, `{"nodeType":"ghost","method":"modes"}`); code != 404 {
		t.Errorf("load-options unknown node: %d", code)
	}
	if code, _ := doJSON(t, srv, http.MethodPost, PathLoadOptions, `nope`); code != 400 {
		t.Errorf("load-options malformed: %d", code)
	}
}

type nanNode struct{}

func (nanNode) Description() NodeDescriptor {
	return NodeDescriptor{Name: "nan", DisplayName: "NaN", Description: "emits NaN"}
}
func (nanNode) Execute(*ExecuteContext) ([][]Item, error) {
	return [][]Item{{{JSON: map[string]any{"x": math.NaN()}}}}, nil
}

func TestHTTPUnserializableOutputIsNodeError(t *testing.T) {
	p := NewPlugin(PluginInfo{ID: "nan-plugin", Name: "NaN", Version: "1"}, nanNode{})
	srv := httptest.NewServer(p.Handler())
	defer srv.Close()
	resp, err := http.Post(srv.URL+PathExecute, "application/json", bytes.NewBufferString(`{"node":{"type":"nan-plugin.nan"},"inputs":[[]]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out ExecuteResponse
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if resp.StatusCode != 200 || out.Error == nil || !strings.Contains(out.Error.Message, "not JSON-serializable") {
		t.Errorf("got %d %+v", resp.StatusCode, out)
	}
}
