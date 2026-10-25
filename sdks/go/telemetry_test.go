package landflow

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	"go.opentelemetry.io/otel/trace"
	"google.golang.org/grpc/metadata"

	pb "github.com/landflow/landflow/sdks/go/landflowpb"
)

func postJSON(t *testing.T, url string, body any, header http.Header) (int, []byte) {
	t.Helper()
	data, _ := json.Marshal(body)
	req, _ := http.NewRequest(http.MethodPost, url, bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range header {
		req.Header[k] = v
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, out
}

func TestHTTPPropagationKeepsParentSpan(t *testing.T) {
	h := newTelHarness(t, testPlugin())
	srv := httptest.NewServer(h.p.Handler())
	defer srv.Close()

	req := execReq("test-plugin.upper", map[string]any{}, map[string]any{"value": "a"}, map[string]any{"value": "b"})
	req.Node.Name = "Shout"
	code, body := postJSON(t, srv.URL+PathExecute, req, http.Header{"Traceparent": {testTraceHdr}})
	if code != 200 {
		t.Fatalf("execute: %d %s", code, body)
	}
	s := h.span(t, "plugin.execute test-plugin.upper")
	if s.SpanContext().TraceID().String() != testTrace || s.Parent().SpanID().String() != testParent || !s.Parent().IsRemote() {
		t.Errorf("parent not preserved: trace=%s parent=%s", s.SpanContext().TraceID(), s.Parent().SpanID())
	}
	if s.SpanKind() != trace.SpanKindServer {
		t.Errorf("kind = %v", s.SpanKind())
	}
	a := attrs(s.Attributes())
	want := map[string]any{
		"landflow.plugin.id": "test-plugin", "landflow.node.type": "test-plugin.upper", "landflow.node.name": "Shout",
		"landflow.workflow.id": "wf_1", "landflow.execution.id": "ex_1", "landflow.execution.mode": "manual",
		"landflow.items.in": int64(2), "landflow.items.out": int64(2),
	}
	for k, v := range want {
		if a[k] != v {
			t.Errorf("attribute %s = %#v, want %#v", k, a[k], v)
		}
	}

	// The node log line and the span.end line carry the host's trace id.
	logs := h.logs.String()
	var nodeLine, endLine map[string]any
	for _, line := range strings.Split(strings.TrimSpace(logs), "\n") {
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("log line is not JSON: %q", line)
		}
		switch m["msg"] {
		case "processed 2 item(s)":
			nodeLine = m
		case "span.end":
			endLine = m
		}
	}
	if nodeLine == nil || nodeLine["trace_id"] != testTrace || nodeLine["span_id"] != s.SpanContext().SpanID().String() ||
		nodeLine["landflow.node.type"] != "test-plugin.upper" || nodeLine["landflow.execution.id"] != "ex_1" ||
		nodeLine["service"] != "landflow-plugin-test-plugin" || nodeLine["level"] != "info" {
		t.Errorf("node log line = %v\nall logs:\n%s", nodeLine, logs)
	}
	if endLine == nil || endLine["span"] != "plugin.execute test-plugin.upper" || endLine["kind"] != "server" ||
		endLine["parent_span_id"] != testParent || endLine["status"] != "ok" {
		t.Errorf("span.end line = %v", endLine)
	}
	if attrsLine, _ := endLine["attributes"].(map[string]any); attrsLine["landflow.items.out"] != 2.0 {
		t.Errorf("span.end attributes = %v", endLine["attributes"])
	}
	// The field order of the spec: ts, level, service, msg, trace_id, span_id.
	first := strings.SplitN(logs, "\n", 2)[0]
	order := []string{`"ts":`, `"level":`, `"service":`, `"msg":`, `"trace_id":`, `"span_id":`}
	last := -1
	for _, k := range order {
		i := strings.Index(first, k)
		if i <= last {
			t.Errorf("field %s out of order in %s", k, first)
		}
		last = i
	}
}

func TestGRPCPropagationKeepsParentSpan(t *testing.T) {
	h := newTelHarness(t, credPlugin())
	client := bufconnClient(t, h.p)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ctx = metadata.AppendToOutgoingContext(ctx, "traceparent", testTraceHdr, "baggage", "tenant=acme")

	echo := newEchoServer(t)
	in, err := ExecuteRequestToProto(sendReq(echo.URL, fakeToken, false))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Execute(ctx, in); err != nil {
		t.Fatal(err)
	}
	server := h.span(t, "plugin.execute cred-plugin.send")
	if server.SpanContext().TraceID().String() != testTrace || server.Parent().SpanID().String() != testParent {
		t.Errorf("gRPC parent not preserved: trace=%s parent=%s", server.SpanContext().TraceID(), server.Parent().SpanID())
	}
	// Child spans: demo.send under the server span, HTTP GET under demo.send,
	// and the external API received the HTTP span as its parent.
	child := h.span(t, "demo.send")
	httpSpan := h.span(t, "HTTP GET")
	if child.Parent().SpanID() != server.SpanContext().SpanID() || httpSpan.Parent().SpanID() != child.SpanContext().SpanID() {
		t.Error("span tree is not server → demo.send → HTTP GET")
	}
	if httpSpan.SpanKind() != trace.SpanKindClient {
		t.Errorf("HTTP span kind = %v", httpSpan.SpanKind())
	}
	wantParent := "00-" + testTrace + "-" + httpSpan.SpanContext().SpanID().String() + "-01"
	if got := echo.lastParent(); got != wantParent {
		t.Errorf("outbound traceparent = %q, want %q", got, wantParent)
	}
	a := attrs(httpSpan.Attributes())
	if a["http.request.method"] != "GET" || a["http.response.status_code"] != int64(http.StatusTeapot) || a["server.address"] != "127.0.0.1" {
		t.Errorf("HTTP span attributes = %v", a)
	}
	if u, _ := a["url.full"].(string); strings.Contains(u, "?") || strings.Contains(u, "key=") || !strings.HasSuffix(u, "/bot"+Redacted+"/getMe") {
		t.Errorf("url.full = %q, want no query string and a masked token", u)
	}
	if _, ok := h.metrics(t)["http.client.request.duration"]; !ok {
		t.Error("http.client.request.duration not recorded")
	}
}

func TestNoSpansForHealthAndManifest(t *testing.T) {
	h := newTelHarness(t, testPlugin())
	srv := httptest.NewServer(h.p.Handler())
	defer srv.Close()
	for _, path := range []string{PathHealth, PathManifest, PathWellKnown, PathMetrics} {
		req, _ := http.NewRequest(http.MethodGet, srv.URL+path, nil)
		req.Header.Set("traceparent", testTraceHdr)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
	}
	client := bufconnClient(t, h.p)
	ctx := metadata.AppendToOutgoingContext(context.Background(), "traceparent", testTraceHdr)
	if _, err := client.Health(ctx, &pb.HealthRequest{}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.GetManifest(ctx, &pb.GetManifestRequest{}); err != nil {
		t.Fatal(err)
	}
	if n := len(h.rec.Ended()); n != 0 {
		t.Errorf("health/manifest/metrics produced %d spans", n)
	}
	if strings.Contains(h.logs.String(), "span.end") {
		t.Errorf("unexpected span.end lines:\n%s", h.logs)
	}
}

func TestMetricsEndpoint(t *testing.T) {
	h := newTelHarness(t, credPlugin())
	srv := httptest.NewServer(h.p.Handler())
	defer srv.Close()
	echo := newEchoServer(t)

	for _, fail := range []bool{false, false, true} {
		if code, body := postJSON(t, srv.URL+PathExecute, sendReq(echo.URL, fakeToken, fail), nil); code != 200 {
			t.Fatalf("execute: %d %s", code, body)
		}
	}
	lo := LoadOptionsRequest{NodeType: "pick", Method: "channels", Credentials: map[string]any{"demoApi": map[string]any{"user": "ada"}}}
	if code, body := postJSON(t, srv.URL+PathLoadOptions, lo, nil); code != 200 {
		t.Fatalf("load-options: %d %s", code, body)
	}

	resp, err := http.Get(srv.URL + PathMetrics)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	text := string(data)
	if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/plain") {
		t.Fatalf("GET /metrics: %d %s", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	for _, want := range []string{
		`landflow_plugin_executions_total{landflow_node_status="success",landflow_node_type="cred-plugin.send"} 2`,
		`landflow_plugin_executions_total{landflow_node_status="error",landflow_node_type="cred-plugin.send"} 1`,
		`landflow_plugin_execute_duration_milliseconds_bucket{landflow_node_status="success",landflow_node_type="cred-plugin.send",le="60000"} 2`,
		`landflow_plugin_items_total{landflow_direction="in",landflow_node_type="cred-plugin.send"} 3`,
		`landflow_plugin_items_total{landflow_direction="out",landflow_node_type="cred-plugin.send"} 2`,
		`landflow_plugin_load_options_total{landflow_load_options_method="channels",landflow_outcome="ok"} 1`,
		`demo_messages_sent_total{demo_kind="text",landflow_node_type="cred-plugin.send",landflow_plugin_id="cred-plugin",landflow_workflow_id="wf_1"} 3`,
		`http_client_request_duration_seconds_bucket`,
		`service_name="landflow-plugin-cred-plugin"`,
	} {
		if !strings.Contains(text, want) {
			t.Errorf("/metrics lacks %s", want)
		}
	}
	mustNotContain(t, "/metrics", text, fakeToken)

	// LANDFLOW_METRICS_PROMETHEUS=false: no endpoint.
	t.Setenv("LANDFLOW_METRICS_PROMETHEUS", "false")
	newTelHarness(t, h.p)
	resp, _ = http.Get(srv.URL + PathMetrics)
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("/metrics with prometheus off: %d", resp.StatusCode)
	}
}

func TestCustomMetricsGuard(t *testing.T) {
	h := newTelHarness(t, credPlugin())
	ec := h.p.contextFor(t, "cred-plugin.send")

	ec.Metrics().Counter("Bad Name").Add(1)
	ec.Metrics().Counter("Bad Name").Add(1)
	ec.Metrics().Histogram("demo.latency", WithUnit("ms")).Record(12)
	ec.Metrics().Gauge("demo.latency").Set(1) // kind clash: dropped
	ec.Metrics().Gauge("demo.queue.depth").Set(7, Attrs{"demo.queue": strings.Repeat("q", 150)})
	ec.Metrics().Counter("demo.negative").Add(-5)
	for i := 0; i < MaxMetricAttributeSets+5; i++ {
		ec.Metrics().Counter("demo.calls").Add(1, Attrs{"demo.i": i})
	}

	ms := h.metrics(t)
	if _, ok := ms["Bad Name"]; ok {
		t.Error("invalid metric name was recorded")
	}
	if strings.Count(h.logs.String(), "invalid metric name") != 1 || !strings.Contains(h.logs.String(), "already a histogram") {
		t.Errorf("warnings:\n%s", h.logs)
	}
	hist := ms["demo.latency"].Data.(metricdata.Histogram[float64])
	if b := hist.DataPoints[0].Bounds; len(b) != len(DurationBucketsMs) || ms["demo.latency"].Unit != "ms" {
		t.Errorf("ms histogram bounds = %v", b)
	}
	gauge := ms["demo.queue.depth"].Data.(metricdata.Gauge[float64]).DataPoints[0]
	if v, _ := gauge.Attributes.Value("demo.queue"); len(v.AsString()) != MaxMetricAttributeLen {
		t.Errorf("attribute not truncated: %d chars", len(v.AsString()))
	}
	for _, k := range []string{"landflow.plugin.id", "landflow.node.type", "landflow.workflow.id"} {
		if _, ok := gauge.Attributes.Value(attributeKey(k)); !ok {
			t.Errorf("auto-attribute %s missing", k)
		}
	}
	sum := ms["demo.calls"].Data.(metricdata.Sum[float64])
	var overflow float64
	for _, dp := range sum.DataPoints {
		if v, ok := dp.Attributes.Value("otel.metric.overflow"); ok && v.AsBool() {
			overflow = dp.Value
		}
	}
	if len(sum.DataPoints) != MaxMetricAttributeSets+1 || overflow != 5 {
		t.Errorf("cardinality guard: %d series, overflow=%v", len(sum.DataPoints), overflow)
	}
	if _, ok := ms["demo.negative"]; ok && len(ms["demo.negative"].Data.(metricdata.Sum[float64]).DataPoints) > 0 {
		t.Error("negative counter increment was recorded")
	}
}

func TestSpansAndDBSpans(t *testing.T) {
	h := newTelHarness(t, credPlugin())
	resp, err := h.p.Execute(context.Background(), execReq("cred-plugin.query", map[string]any{}, map[string]any{}))
	if err != nil || resp.Error != nil {
		t.Fatalf("execute: %v %+v", err, resp.Error)
	}
	server := h.span(t, "plugin.execute cred-plugin.query")
	db := h.span(t, "SELECT users")
	if db.SpanKind() != trace.SpanKindClient || db.Parent().SpanID() != server.SpanContext().SpanID() {
		t.Errorf("db span kind/parent wrong: %v", db.SpanKind())
	}
	a := attrs(db.Attributes())
	for k, v := range map[string]any{
		"db.system": "postgresql", "db.operation.name": "SELECT", "db.collection.name": "users", "db.namespace": "app",
		"db.query.text": "SELECT id FROM users WHERE id = $1", "server.address": "db.local", "server.port": int64(5432),
		"db.response.returned_rows": int64(2),
	} {
		if a[k] != v {
			t.Errorf("db attribute %s = %#v, want %#v", k, a[k], v)
		}
	}
	outer, redis := h.span(t, "import"), h.span(t, "GET")
	if redis.Parent().SpanID() != outer.SpanContext().SpanID() || outer.Parent().SpanID() != server.SpanContext().SpanID() {
		t.Error("nested DB span is not a child of the custom span")
	}
	if redis.Status().Code != codes.Error || redis.Status().Description != "connection refused" || outer.Status().Code != codes.Error {
		t.Errorf("error status not recorded: %v / %v", redis.Status(), outer.Status())
	}
	if len(redis.Events()) == 0 || redis.Events()[0].Name != "exception" {
		t.Error("exception event missing")
	}
	if h.span(t, "manual").Parent().SpanID() != server.SpanContext().SpanID() {
		t.Error("StartSpan parent wrong")
	}
	if !strings.Contains(h.logs.String(), `"msg":"span.end","span":"GET","kind":"client"`) ||
		!strings.Contains(h.logs.String(), `"level":"error"`) || !strings.Contains(h.logs.String(), `"error":"connection refused"`) {
		t.Errorf("span.end error line missing:\n%s", h.logs)
	}
}

func TestCredentialTestSpansAndMetrics(t *testing.T) {
	h := newTelHarness(t, credPlugin())
	resp, err := h.p.TestCredentials(context.Background(), &TestCredentialsRequest{CredentialType: "demoApi", Data: map[string]any{"accessToken": goodToken}})
	if err != nil || !resp.OK {
		t.Fatalf("test credentials: %v %+v", err, resp)
	}
	db := h.span(t, "SELECT")
	if db.SpanKind() != trace.SpanKindClient || !db.Parent().IsValid() {
		t.Errorf("DBSpanFrom span kind/parent: %v %v", db.SpanKind(), db.Parent())
	}
	if _, ok := h.metrics(t)["demo.credential.checks"]; !ok {
		t.Error("MetricsFrom counter not recorded")
	}
}

func TestExecuteErrorStatus(t *testing.T) {
	h := newTelHarness(t, testPlugin())
	resp, _ := h.p.Execute(context.Background(), execReq("test-plugin.behave", map[string]any{"do": "plain"}))
	if resp.Error == nil {
		t.Fatal("expected node error")
	}
	s := h.span(t, "plugin.execute test-plugin.behave")
	if s.Status().Code != codes.Error || s.Status().Description != "plain failure" || s.Events()[0].Name != "exception" {
		t.Errorf("status %v events %v", s.Status(), s.Events())
	}
	ms := h.metrics(t)
	dp := ms["landflow.plugin.executions"].Data.(metricdata.Sum[int64]).DataPoints[0]
	if v, _ := dp.Attributes.Value("landflow.node.status"); v.AsString() != "error" {
		t.Errorf("executions status = %v", v.AsString())
	}
	// A panic is logged with its stack through the structured logger.
	_, _ = h.p.Execute(context.Background(), execReq("test-plugin.behave", map[string]any{"do": "panic"}))
	if !strings.Contains(h.logs.String(), `panic in node \"behave\": boom`) || !strings.Contains(h.logs.String(), `"stack":`) {
		t.Errorf("panic not logged:\n%s", h.logs)
	}
}

func TestTelemetryDisabled(t *testing.T) {
	t.Setenv("OTEL_SDK_DISABLED", "true")
	h := newTelHarness(t, testPlugin())
	srv := httptest.NewServer(h.p.Handler())
	defer srv.Close()
	code, _ := postJSON(t, srv.URL+PathExecute, execReq("test-plugin.upper", map[string]any{}, map[string]any{"value": "a"}),
		http.Header{"Traceparent": {testTraceHdr}})
	if code != 200 {
		t.Fatal(code)
	}
	if len(h.rec.Ended()) != 0 || h.tel.Enabled() {
		t.Error("spans recorded with OTEL_SDK_DISABLED=true")
	}
	resp, _ := http.Get(srv.URL + PathMetrics)
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("/metrics while disabled: %d", resp.StatusCode)
	}
	// Logs still flow and keep the propagated trace id.
	if !strings.Contains(h.logs.String(), `"trace_id":"`+testTrace+`","span_id":"`+testParent+`"`) {
		t.Errorf("disabled telemetry lost the trace context in logs:\n%s", h.logs)
	}
}

func TestServiceNameAndPrettyLogs(t *testing.T) {
	t.Setenv("OTEL_SERVICE_NAME", "custom-svc")
	h := newTelHarness(t, testPlugin(), func(o *TelemetryOptions) { o.LogFormat = "pretty"; o.LogLevel = "warn" })
	if h.tel.ServiceName() != "custom-svc" {
		t.Errorf("service = %q", h.tel.ServiceName())
	}
	_, _ = h.p.Execute(context.Background(), execReq("test-plugin.upper", map[string]any{}, map[string]any{"value": "a"}))
	if strings.Contains(h.logs.String(), "processed") || strings.Contains(h.logs.String(), "span.end") {
		t.Errorf("info lines written at level warn:\n%s", h.logs)
	}
	h.tel.Logger().Warn("disk low", "free_mb", 12, "password", "hunter2-FAKE")
	line := h.logs.String()
	if !strings.Contains(line, " warn  custom-svc disk low free_mb=12 password=[REDACTED]") {
		t.Errorf("pretty line = %q", line)
	}
}

func TestLogHandlerRedactsSecretKeys(t *testing.T) {
	var buf bytes.Buffer
	l := slog.New(newLogHandler(&buf, slog.LevelDebug, false, "svc"))
	l.With("component", "x").WithGroup("http").Info("req",
		"authorization", "Bearer FAKE", "status", 200, "gen_ai.usage.input_tokens", 42,
		slog.Group("headers", "Cookie", "sid=FAKE", "accept", "json"))
	var m map[string]any
	if err := json.Unmarshal(buf.Bytes(), &m); err != nil {
		t.Fatal(err)
	}
	if m["http.authorization"] != Redacted || m["http.status"] != 200.0 || m["component"] != "x" ||
		m["http.gen_ai.usage.input_tokens"] != 42.0 {
		t.Errorf("line = %v", m)
	}
	if hdr := m["http.headers"].(map[string]any); hdr["Cookie"] != Redacted || hdr["accept"] != "json" {
		t.Errorf("group = %v", hdr)
	}
}

func TestLoggerWithAttrs(t *testing.T) {
	ctx := NewExecuteContext(context.Background(), &ExecuteRequest{}, nil)
	ctx.Logger.With("rows", 3, "table", "users").Info("query %s", "done")
	ctx.Logger.Info("plain")
	got := ctx.Logger.Entries()
	if len(got) != 2 || got[0].Message != "query done rows=3 table=users" || got[1].Message != "plain" {
		t.Errorf("entries = %#v", got)
	}
}

// contextFor returns an ExecuteContext wired to the plugin's telemetry, as
// Execute builds it.
func (p *Plugin) contextFor(t *testing.T, nodeType string) *ExecuteContext {
	t.Helper()
	rn, err := p.find(nodeType)
	if err != nil {
		t.Fatal(err)
	}
	sc := &scope{tel: p.tel(), nodeType: nodeType, workflowID: "wf_1"}
	return NewExecuteContext(withScope(context.Background(), sc), &ExecuteRequest{WorkflowID: "wf_1"}, &rn.descriptor)
}
