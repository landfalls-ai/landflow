package landflow

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

// Fake secrets only: these values exist to prove they never reach logs or spans.
const (
	fakeToken    = "tok-FAKE-1234567890"
	goodToken    = "tok-GOOD-0987654321"
	testTrace    = "4bf92f3577b34da6a3ce929d0e0e4736"
	testParent   = "00f067aa0ba902b7"
	testTraceHdr = "00-" + testTrace + "-" + testParent + "-01"
)

var demoCredential = CredentialType{
	Name: "demoApi", DisplayName: "Demo API", DocumentationURL: "https://example.invalid/docs",
	Properties: []PropertyDescriptor{
		{Name: "accessToken", DisplayName: "Access Token", Type: PropString, Required: true, TypeOptions: &TypeOptions{Password: true}},
		{Name: "baseUrl", DisplayName: "Base URL", Type: PropString, Default: "https://api.example.invalid"},
		{Name: "user", DisplayName: "User", Type: PropString},
	},
	Test: func(ctx context.Context, data CredentialData) (bool, string) {
		if !trace.SpanContextFromContext(ctx).IsValid() {
			return false, "no span in context"
		}
		_ = DBSpanFrom(ctx, DBSpanInfo{System: "postgresql", Operation: "SELECT", Statement: "SELECT 1"}, nil)
		MetricsFrom(ctx).Counter("demo.credential.checks").Add(1)
		if base := data.String("baseUrl"); base != "" {
			resp, err := HTTPClient(ctx).Get(base + "/check")
			if err != nil {
				return false, err.Error()
			}
			resp.Body.Close()
		}
		if data.String("accessToken") != goodToken {
			return false, "invalid token " + data.String("accessToken")
		}
		return true, ""
	},
}

var plainCredential = CredentialType{
	Name: "plainApi", DisplayName: "Plain API",
	Properties: []PropertyDescriptor{{Name: "key", DisplayName: "Key", Type: PropString}},
}

// sendNode uses demoApi credentials, logs, spans, metrics and the HTTP client.
type sendNode struct{}

func (sendNode) Description() NodeDescriptor {
	return NodeDescriptor{
		Name: "send", DisplayName: "Send", Description: "Calls the demo API",
		Credentials: []NodeCredentialRequirement{{Name: "demoApi", Required: true}},
		Properties:  []PropertyDescriptor{{Name: "fail", DisplayName: "Fail", Type: PropBoolean, Default: false}},
	}
}

func (sendNode) Execute(ctx *ExecuteContext) ([][]Item, error) {
	creds, err := ctx.RequireCredentials("demoApi")
	if err != nil {
		return nil, err
	}
	token, base := creds.String("accessToken"), creds.String("baseUrl")
	ctx.Logger.Info("calling %s with token %s", base, token)
	ctx.Logger.With("api_key", "k-FAKE-55555", "count", 2, "note", "token="+token).Warn("structured")
	status := 0
	err = ctx.Span("demo.send", Attrs{"demo.token_used": token, "authorization": "Bearer abc", "demo.count": 3}, func(span Span) error {
		resp, err := HTTPClient(span).Get(base + "/bot" + token + "/getMe?key=" + token + "&x=1")
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		status = resp.StatusCode
		span.SetAttribute("demo.status", status)
		return nil
	})
	if err != nil {
		return nil, err
	}
	ctx.Metrics().Counter("demo.messages.sent").Add(1, Attrs{"demo.kind": "text"})
	if ctx.ParamBool("fail", 0, false) {
		return nil, fmt.Errorf("request to %s/bot%s failed", base, token)
	}
	return [][]Item{{{JSON: map[string]any{"status": status, "user": ctx.CredentialString("demoApi", "user")}}}}, nil
}

// pollNode is a poll trigger over a fake feed whose newest id is the
// "latest" parameter (ids 1..latest).
type pollNode struct{}

func (pollNode) Description() NodeDescriptor {
	return NodeDescriptor{
		Name: "feed", DisplayName: "Feed Trigger", Description: "New feed entries",
		TriggerSource: TriggerPoll,
		Properties:    []PropertyDescriptor{{Name: "latest", DisplayName: "Latest", Type: PropNumber, Default: 3}},
	}
}

func (pollNode) Execute(ctx *ExecuteContext) ([][]Item, error) {
	latest := ctx.ParamInt("latest", 0, 3)
	if ctx.Mode() == ModeManual {
		ctx.SetPollState(map[string]any{"lastId": latest}) // dropped in manual mode
		return [][]Item{{{JSON: map[string]any{"id": latest}}}}, nil
	}
	last := CredentialData(ctx.PollState()).Int("lastId", 0)
	ctx.SetPollState(map[string]any{"lastId": latest})
	if ctx.IsFirstPoll() {
		return nil, nil
	}
	var out []Item
	for id := last + 1; id <= latest; id++ {
		out = append(out, Item{JSON: map[string]any{"id": id}})
	}
	return [][]Item{out}, nil
}

// optionsNode serves LoadOptionsWithContext from its credentials.
type optionsNode struct{}

func (optionsNode) Description() NodeDescriptor {
	return NodeDescriptor{
		Name: "pick", DisplayName: "Pick", Description: "Dynamic options from the API",
		Credentials: []NodeCredentialRequirement{{Name: "demoApi"}},
		Properties: []PropertyDescriptor{{Name: "channel", DisplayName: "Channel", Type: PropOptions,
			TypeOptions: &TypeOptions{LoadOptionsMethod: "channels"}}},
	}
}

func (optionsNode) Execute(ctx *ExecuteContext) ([][]Item, error) {
	return [][]Item{ctx.InputData(0)}, nil
}

func (optionsNode) LoadOptionsWithContext(ctx *LoadOptionsContext) ([]PropertyOption, error) {
	if ctx.Method() != "channels" {
		return nil, fmt.Errorf("unknown method %q", ctx.Method())
	}
	user := ctx.CredentialString("demoApi", "user")
	if user == "" {
		return nil, errors.New("no credentials")
	}
	var opts []PropertyOption
	err := ctx.Span("demo.list_channels", nil, func(span Span) error {
		opts = []PropertyOption{{Name: "#general (" + user + ")", Value: "general"}}
		return nil
	})
	return opts, err
}

// dbNode opens database spans, nested and failing.
type dbNode struct{}

func (dbNode) Description() NodeDescriptor {
	return NodeDescriptor{Name: "query", DisplayName: "Query", Description: "Database spans"}
}

func (dbNode) Execute(ctx *ExecuteContext) ([][]Item, error) {
	err := ctx.DBSpan(DBSpanInfo{System: "postgresql", Operation: "SELECT", Collection: "users", Namespace: "app",
		Statement: "SELECT id FROM users WHERE id = $1", ServerAddress: "db.local", ServerPort: 5432},
		func(span Span) error {
			span.SetAttribute("db.response.returned_rows", 2)
			return nil
		})
	if err != nil {
		return nil, err
	}
	err = ctx.Span("import", Attrs{"import.batch": 1}, func(span Span) error {
		return span.DBSpan(DBSpanInfo{System: "redis", Operation: "GET"}, func(Span) error {
			return errors.New("connection refused")
		})
	})
	manual := ctx.StartSpan("manual", nil)
	manual.End()
	return [][]Item{{{JSON: map[string]any{"ok": err == nil}}}}, nil
}

func credPlugin() *Plugin {
	return NewPlugin(PluginInfo{
		ID: "cred-plugin", Name: "Cred Plugin", Version: "0.0.1",
		CredentialTypes: []CredentialType{demoCredential, plainCredential},
	}, sendNode{}, pollNode{}, optionsNode{}, dbNode{})
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type telHarness struct {
	p      *Plugin
	tel    *Telemetry
	rec    *tracetest.SpanRecorder
	reader *sdkmetric.ManualReader
	logs   *syncBuffer
}

func newTelHarness(t *testing.T, p *Plugin, tweak ...func(*TelemetryOptions)) *telHarness {
	t.Helper()
	h := &telHarness{p: p, rec: tracetest.NewSpanRecorder(), reader: sdkmetric.NewManualReader(), logs: &syncBuffer{}}
	opts := TelemetryOptions{
		SpanProcessors: []sdktrace.SpanProcessor{h.rec},
		MetricReaders:  []sdkmetric.Reader{h.reader},
		LogWriter:      h.logs,
		NoOTLP:         true,
	}
	for _, f := range tweak {
		f(&opts)
	}
	tel, err := p.SetupTelemetry(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	h.tel = tel
	t.Cleanup(func() { _ = tel.Shutdown(context.Background()) })
	return h
}

func (h *telHarness) spans(name string) []sdktrace.ReadOnlySpan {
	var out []sdktrace.ReadOnlySpan
	for _, s := range h.rec.Ended() {
		if s.Name() == name {
			out = append(out, s)
		}
	}
	return out
}

func (h *telHarness) span(t *testing.T, name string) sdktrace.ReadOnlySpan {
	t.Helper()
	got := h.spans(name)
	if len(got) != 1 {
		var names []string
		for _, s := range h.rec.Ended() {
			names = append(names, s.Name())
		}
		t.Fatalf("want exactly one span %q, got %d (ended: %v)", name, len(got), names)
	}
	return got[0]
}

func (h *telHarness) metrics(t *testing.T) map[string]metricdata.Metrics {
	t.Helper()
	var rm metricdata.ResourceMetrics
	if err := h.reader.Collect(context.Background(), &rm); err != nil {
		t.Fatal(err)
	}
	out := map[string]metricdata.Metrics{}
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			out[m.Name] = m
		}
	}
	return out
}

func attrs(kvs []attribute.KeyValue) map[string]any {
	out := map[string]any{}
	for _, kv := range kvs {
		out[string(kv.Key)] = kv.Value.AsInterface()
	}
	return out
}

// echoServer records the traceparent of each request it receives.
type echoServer struct {
	*httptest.Server
	mu      sync.Mutex
	parents []string
	paths   []string
}

func newEchoServer(t *testing.T) *echoServer {
	e := &echoServer{}
	e.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		e.mu.Lock()
		e.parents = append(e.parents, r.Header.Get("traceparent"))
		e.paths = append(e.paths, r.URL.RequestURI())
		e.mu.Unlock()
		w.WriteHeader(http.StatusTeapot)
	}))
	t.Cleanup(e.Close)
	return e
}

func (e *echoServer) lastParent() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	if len(e.parents) == 0 {
		return ""
	}
	return e.parents[len(e.parents)-1]
}

func sendReq(base, token string, fail bool) *ExecuteRequest {
	req := execReq("cred-plugin.send", map[string]any{"fail": fail}, map[string]any{"x": 1})
	req.Credentials = map[string]any{"demoApi": map[string]any{"accessToken": token, "baseUrl": base, "user": "ada"}}
	return req
}

func mustNotContain(t *testing.T, what, haystack string, needles ...string) {
	t.Helper()
	for _, n := range needles {
		if strings.Contains(haystack, n) {
			t.Errorf("%s leaks %q:\n%s", what, n, haystack)
		}
	}
}
