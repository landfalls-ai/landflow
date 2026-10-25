package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/landflow/landflow/plugins/google-workspace/internal/fakegoogle"
	landflow "github.com/landflow/landflow/sdks/go"
)

// Test harness: a fake Google (token endpoint + APIs) on httptest, a
// throwaway RSA key generated per test binary, and helpers to execute nodes.

const saEmail = "robot@test-project.iam.gserviceaccount.com"

var testKey = sync.OnceValue(func() *rsa.PrivateKey {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		panic(err)
	}
	return key
})

func pemPKCS8(key *rsa.PrivateKey) string {
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		panic(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
}

type harness struct {
	t      *testing.T
	fake   *fakegoogle.Server
	url    string
	plugin *landflow.Plugin
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	tokenCache.Clear()
	fake := fakegoogle.New()
	fake.PublicKey = &testKey().PublicKey
	fake.ServiceAccountEmail = saEmail
	fake.ClientID, fake.ClientSecret, fake.RefreshToken = "client-1.apps.googleusercontent.com", "oauth-client-secret-1", "oauth-refresh-token-1"
	srv := httptest.NewServer(fake)
	t.Cleanup(srv.Close)
	return &harness{t: t, fake: fake, url: srv.URL, plugin: newPlugin()}
}

// sa is service-account credential data impersonating me@example.com.
func (h *harness) sa() map[string]any {
	return map[string]any{
		"email": saEmail, "privateKey": pemPKCS8(testKey()), "delegatedEmail": "me@example.com",
		"tokenUrl": h.url + "/token", "baseUrl": h.url,
	}
}

func (h *harness) oauth() map[string]any {
	return map[string]any{
		"clientId": "client-1.apps.googleusercontent.com", "clientSecret": "oauth-client-secret-1",
		"refreshToken": "oauth-refresh-token-1", "tokenUrl": h.url + "/token", "baseUrl": h.url,
	}
}

// execOpts customises one execution.
type execOpts struct {
	mode      landflow.ExecutionMode
	creds     map[string]any // credential type → data (default: service account)
	pollState map[string]any
	items     []map[string]any
	perItem   []map[string]any // itemParameters overrides per item
}

func (h *harness) exec(node string, params map[string]any, o execOpts) *landflow.ExecuteResponse {
	h.t.Helper()
	return h.execCtx(context.Background(), node, params, o)
}

func (h *harness) execCtx(ctx context.Context, node string, params map[string]any, o execOpts) *landflow.ExecuteResponse {
	h.t.Helper()
	if o.mode == "" {
		o.mode = landflow.ModeManual
	}
	if o.creds == nil {
		o.creds = map[string]any{credServiceAccount: h.sa()}
	}
	req := &landflow.ExecuteRequest{
		Protocol: landflow.ProtocolVersion, ExecutionID: "ex-1", WorkflowID: "wf-1", Mode: o.mode,
		Node:       landflow.NodeRef{ID: "n1", Name: "Google", Type: "google." + node, TypeVersion: 1},
		Parameters: params, Credentials: o.creds, PollState: viaJSON(h.t, o.pollState),
	}
	if o.mode == landflow.ModePoll {
		req.Inputs = [][]landflow.Item{}
	} else {
		if o.items == nil {
			o.items = []map[string]any{{}}
		}
		req.Inputs = [][]landflow.Item{{}}
		for k, it := range o.items {
			req.Inputs[0] = append(req.Inputs[0], landflow.Item{JSON: it})
			p := cloneMap(params)
			if k < len(o.perItem) {
				for key, v := range o.perItem[k] {
					p[key] = v
				}
			}
			req.ItemParameters = append(req.ItemParameters, p)
		}
	}
	resp, err := h.plugin.Execute(ctx, req)
	if err != nil {
		h.t.Fatalf("%s: %v", node, err)
	}
	return resp
}

// viaJSON round-trips poll state as the host stores it (numbers become
// float64, string slices []any).
func viaJSON(t *testing.T, state map[string]any) map[string]any {
	t.Helper()
	if state == nil {
		return nil
	}
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// ok returns output 0's JSON objects, failing on a node error.
func (h *harness) ok(resp *landflow.ExecuteResponse) []map[string]any {
	h.t.Helper()
	if resp.Error != nil {
		h.t.Fatalf("node error: %s (%s)", resp.Error.Message, resp.Error.Description)
	}
	var out []map[string]any
	if len(resp.Outputs) > 0 {
		for _, it := range resp.Outputs[0] {
			out = append(out, it.JSON)
		}
	}
	return out
}

func (h *harness) loadOptions(node, method string, params map[string]any, creds map[string]any) []landflow.PropertyOption {
	h.t.Helper()
	if creds == nil {
		creds = map[string]any{credServiceAccount: h.sa()}
	}
	resp, err := h.plugin.LoadOptions(context.Background(), &landflow.LoadOptionsRequest{
		NodeType: "google." + node, Method: method, Parameters: params, Credentials: creds,
	})
	if err != nil {
		h.t.Fatalf("loadOptions %s/%s: %v", node, method, err)
	}
	return resp.Options
}

// telemetry wires in-memory exporters into the harness's plugin.
type telemetry struct {
	spans   *tracetest.SpanRecorder
	metrics *sdkmetric.ManualReader
	logs    *bytes.Buffer
}

func (h *harness) withTelemetry() *telemetry {
	h.t.Helper()
	tel := &telemetry{spans: tracetest.NewSpanRecorder(), metrics: sdkmetric.NewManualReader(), logs: &bytes.Buffer{}}
	t, err := h.plugin.SetupTelemetry(context.Background(), landflow.TelemetryOptions{
		SpanProcessors: []sdktrace.SpanProcessor{tel.spans}, MetricReaders: []sdkmetric.Reader{tel.metrics},
		LogWriter: syncWriter{w: tel.logs}, NoOTLP: true,
	})
	if err != nil {
		h.t.Fatal(err)
	}
	h.t.Cleanup(func() { _ = t.Shutdown(context.Background()) })
	return tel
}

// syncWriter serialises log writes from concurrent goroutines.
type syncWriter struct{ w io.Writer }

var logMu sync.Mutex

func (s syncWriter) Write(p []byte) (int, error) {
	logMu.Lock()
	defer logMu.Unlock()
	return s.w.Write(p)
}

// counter sums a counter's data points whose attributes include want.
func (tel *telemetry) counter(t *testing.T, name string, want map[string]string) float64 {
	t.Helper()
	var rm metricdata.ResourceMetrics
	if err := tel.metrics.Collect(context.Background(), &rm); err != nil {
		t.Fatal(err)
	}
	total := 0.0
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			if m.Name != name {
				continue
			}
			sum, ok := m.Data.(metricdata.Sum[float64])
			if !ok {
				t.Fatalf("%s is %T, want a float64 sum", name, m.Data)
			}
			for _, dp := range sum.DataPoints {
				match := true
				for k, v := range want {
					got, ok := dp.Attributes.Value(attribute.Key(k))
					match = match && ok && got.AsString() == v
				}
				if match {
					total += dp.Value
				}
			}
		}
	}
	return total
}

// spansNamed returns ended spans with this name (prefix match with "*").
func (tel *telemetry) spansNamed(name string) []sdktrace.ReadOnlySpan {
	var out []sdktrace.ReadOnlySpan
	for _, s := range tel.spans.Ended() {
		if s.Name() == name || (strings.HasSuffix(name, "*") && strings.HasPrefix(s.Name(), strings.TrimSuffix(name, "*"))) {
			out = append(out, s)
		}
	}
	return out
}

func spanAttr(s sdktrace.ReadOnlySpan, key string) (string, bool) {
	for _, kv := range s.Attributes() {
		if string(kv.Key) == key {
			return kv.Value.Emit(), true
		}
	}
	return "", false
}

func errorText(resp *landflow.ExecuteResponse) string {
	if resp.Error == nil {
		return ""
	}
	return resp.Error.Message + " | " + resp.Error.Description
}
