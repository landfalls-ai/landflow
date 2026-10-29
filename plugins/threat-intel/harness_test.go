package main

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	landflow "github.com/landflow/landflow/sdks/go"
)

// Test harness: a fake threat-intel server on httptest that records every request, and helpers to execute nodes.

// reply is a canned answer. A route may also be a func(http.ResponseWriter, *http.Request).
type reply struct {
	status int // default 200
	body   any // JSON-encoded unless a string
	header map[string]string
}

// recorded is one request the fake saw.
type recorded struct {
	method, path, rawQuery string
	header                 http.Header
	body                   string
}

func (r recorded) query(t *testing.T, key string) string {
	t.Helper()
	vals, err := parseQuery(r.rawQuery)
	if err != nil {
		t.Fatal(err)
	}
	return vals.Get(key)
}

type fake struct {
	t      *testing.T
	srv    *httptest.Server
	mu     sync.Mutex
	reqs   []recorded
	routes map[string]any // "METHOD /escaped/path" → reply | func
}

func newFake(t *testing.T, routes map[string]any) *fake {
	t.Helper()
	f := &fake{t: t, routes: routes}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fake) serve(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	f.reqs = append(f.reqs, recorded{r.Method, r.URL.EscapedPath(), r.URL.RawQuery, r.Header.Clone(), string(body)})
	route, ok := f.routes[r.Method+" "+r.URL.EscapedPath()]
	if !ok {
		route, ok = f.routes["ANY"] // a catch-all
	}
	f.mu.Unlock()
	switch h := route.(type) {
	case func(http.ResponseWriter, *http.Request):
		h(w, r)
	case reply:
		for k, v := range h.header {
			w.Header().Set(k, v)
		}
		w.Header().Set("Content-Type", "application/json")
		status := h.status
		if status == 0 {
			status = http.StatusOK
		}
		w.WriteHeader(status)
		if s, isString := h.body.(string); isString {
			_, _ = io.WriteString(w, s)
		} else if h.body != nil {
			_ = json.NewEncoder(w).Encode(h.body)
		}
	default:
		_ = ok
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"message":"no such route in the fake"}`)
	}
}

func (f *fake) requests() []recorded {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]recorded(nil), f.reqs...)
}

func (f *fake) count() int { return len(f.requests()) }

// only returns the single request the fake saw.
func (f *fake) only() recorded {
	f.t.Helper()
	reqs := f.requests()
	if len(reqs) != 1 {
		f.t.Fatalf("fake saw %d requests, want 1: %+v", len(reqs), reqs)
	}
	return reqs[0]
}

// creds is credential data pointing a service at this fake.
func (f *fake) creds(key string) map[string]any {
	return map[string]any{"apiKey": key, "baseUrl": f.srv.URL}
}

func ok200(body any) reply { return reply{body: body} }

// noSleep makes 429 waits instant and records them.
func noSleep(t *testing.T) *[]time.Duration {
	t.Helper()
	var mu sync.Mutex
	var waits []time.Duration
	orig := sleep
	sleep = func(_ context.Context, d time.Duration) error {
		mu.Lock()
		defer mu.Unlock()
		waits = append(waits, d)
		return nil
	}
	t.Cleanup(func() { sleep = orig })
	return &waits
}

type harness struct {
	t      *testing.T
	plugin *landflow.Plugin
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	cache.reset()
	return &harness{t: t, plugin: newPlugin()}
}

// execOpts customises one execution.
type execOpts struct {
	creds     map[string]any   // credential type → data
	items     []map[string]any // input items (default: one empty item)
	keepGoing bool
}

func (h *harness) exec(node string, params map[string]any, o execOpts) *landflow.ExecuteResponse {
	h.t.Helper()
	if o.items == nil {
		o.items = []map[string]any{{}}
	}
	req := &landflow.ExecuteRequest{
		Protocol: landflow.ProtocolVersion, ExecutionID: "ex-1", WorkflowID: "wf-1", Mode: landflow.ModeManual,
		Node:       landflow.NodeRef{ID: "n1", Name: "Threat Intel", Type: "threat-intel." + node, TypeVersion: 1},
		Parameters: params, Credentials: o.creds, ContinueOnFail: o.keepGoing,
		Inputs: [][]landflow.Item{{}},
	}
	for _, it := range o.items {
		req.Inputs[0] = append(req.Inputs[0], landflow.Item{JSON: it})
		req.ItemParameters = append(req.ItemParameters, params)
	}
	resp, err := h.plugin.Execute(context.Background(), req)
	if err != nil {
		h.t.Fatalf("%s: %v", node, err)
	}
	return resp
}

// ok returns output 0's JSON objects after a JSON round trip (as the host sees them), failing on a node error.
func (h *harness) ok(resp *landflow.ExecuteResponse) []map[string]any {
	h.t.Helper()
	if resp.Error != nil {
		h.t.Fatalf("node error: %s (%s)", resp.Error.Message, resp.Error.Description)
	}
	var out []map[string]any
	if len(resp.Outputs) > 0 {
		for _, it := range resp.Outputs[0] {
			data, err := json.Marshal(it.JSON)
			if err != nil {
				h.t.Fatal(err)
			}
			var m map[string]any
			if err := json.Unmarshal(data, &m); err != nil {
				h.t.Fatal(err)
			}
			out = append(out, m)
		}
	}
	return out
}

// one runs the node and returns its single output item.
func (h *harness) one(node string, params map[string]any, o execOpts) map[string]any {
	h.t.Helper()
	out := h.ok(h.exec(node, params, o))
	if len(out) != 1 {
		h.t.Fatalf("%s returned %d items, want 1: %v", node, len(out), out)
	}
	return out[0]
}

// failure runs the node and returns its error.
func (h *harness) failure(node string, params map[string]any, o execOpts) *landflow.NodeErrorPayload {
	h.t.Helper()
	resp := h.exec(node, params, o)
	if resp.Error == nil {
		h.t.Fatalf("%s: expected a node error, got %v", node, resp.Outputs)
	}
	return resp.Error
}

func contains(t *testing.T, got, want string) {
	t.Helper()
	if !strings.Contains(got, want) {
		t.Errorf("%q does not contain %q", got, want)
	}
}

func eq(t *testing.T, what string, got, want any) {
	t.Helper()
	if got != want {
		t.Errorf("%s = %v, want %v", what, got, want)
	}
}

func parseQuery(raw string) (url.Values, error) { return url.ParseQuery(raw) }

func jsonEncode(w http.ResponseWriter, v any) error {
	w.Header().Set("Content-Type", "application/json")
	return json.NewEncoder(w).Encode(v)
}

func mustJSON(t *testing.T, s string, out any) {
	t.Helper()
	if err := json.Unmarshal([]byte(s), out); err != nil {
		t.Fatalf("%q: %v", s, err)
	}
}

func toStrings(v any) []string {
	if s, ok := v.(string); ok {
		return []string{s}
	}
	var out []string
	for _, e := range list(v) {
		out = append(out, str(e))
	}
	return out
}

// newTLSServer replaces f's server with a TLS one (a self-signed certificate) serving the same routes.
func newTLSServer(f *fake, routes map[string]any) *httptest.Server {
	f.routes = routes
	srv := httptest.NewUnstartedServer(http.HandlerFunc(f.serve))
	srv.Config.ErrorLog = log.New(io.Discard, "", 0) // the strict-TLS client's rejected handshake is expected
	srv.StartTLS()
	f.t.Cleanup(srv.Close)
	return srv
}
