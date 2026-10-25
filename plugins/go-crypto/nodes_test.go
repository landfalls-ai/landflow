package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"regexp"
	"strings"
	"testing"
	"time"

	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	landflow "github.com/landflow/landflow/sdks/go"
)

func run(t *testing.T, node string, params map[string]any, items ...map[string]any) *landflow.ExecuteResponse {
	t.Helper()
	req := &landflow.ExecuteRequest{
		Protocol: landflow.ProtocolVersion, ExecutionID: "ex", Mode: landflow.ModeManual,
		Node:       landflow.NodeRef{ID: "n", Name: "N", Type: "go-crypto." + node, TypeVersion: 1},
		Parameters: params, Inputs: [][]landflow.Item{{}},
	}
	for _, it := range items {
		req.Inputs[0] = append(req.Inputs[0], landflow.Item{JSON: it})
		req.ItemParameters = append(req.ItemParameters, params)
	}
	resp, err := newPlugin().Execute(context.Background(), req)
	if err != nil {
		t.Fatalf("%s: %v", node, err)
	}
	return resp
}

func TestManifest(t *testing.T) {
	m := newPlugin().Manifest()
	const svgIcon = "data:image/svg+xml;base64,"
	if m.Plugin.ID != "go-crypto" || m.Plugin.Name != "Crypto Toolkit" || m.Plugin.Language != "go" ||
		!strings.HasPrefix(m.Plugin.Icon, svgIcon) || m.Plugin.Color != "#0d9488" {
		t.Errorf("plugin info = %.200v", m.Plugin)
	}
	want := map[string]bool{"hash": true, "uuid": true, "base64": false, "jwtDecode": true}
	for _, d := range m.Nodes {
		tool, ok := want[d.Name]
		if !ok {
			t.Errorf("unexpected node %q", d.Name)
		}
		if d.UsableAsTool != tool {
			t.Errorf("%s usableAsTool = %v", d.Name, d.UsableAsTool)
		}
		if tool && d.ToolDescription == "" {
			t.Errorf("%s needs a toolDescription", d.Name)
		}
		if !strings.HasPrefix(d.Icon, svgIcon) {
			t.Errorf("%s icon = %.60q, want an embedded SVG", d.Name, d.Icon)
		}
	}
	data, _ := json.Marshal(m)
	if strings.Contains(string(data), "file:") {
		t.Error("manifest must not leak file: icons")
	}
	if !strings.Contains(string(data), `"loadOptionsMethod":"algorithms"`) {
		t.Error("hash must reference loadOptionsMethod algorithms")
	}
}

func TestHash(t *testing.T) {
	cases := []struct {
		algo, enc, want string
	}{
		{"sha256", "hex", "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"},
		{"sha1", "hex", "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d"},
		{"md5", "hex", "5d41402abc4b2a76b9719d911017c592"},
		{"sha512", "hex", "9b71d224bd62f3785d96d46ad3ea3d73319bfbc2890caadae2dff72519673ca72323c3d99ba5c11d7c7acc6e14b8c5da0c4663475c2e5c3adef46f73bcdec043"},
		{"sha256", "base64", "LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ="},
	}
	for _, c := range cases {
		resp := run(t, "hash", map[string]any{"algorithm": c.algo, "encoding": c.enc}, map[string]any{"value": "hello"})
		if resp.Error != nil {
			t.Fatalf("%s: %+v", c.algo, resp.Error)
		}
		got := resp.Outputs[0][0]
		if got.JSON["hash"] != c.want || got.JSON["value"] != "hello" || got.PairedItem.Item != 0 {
			t.Errorf("%s/%s = %+v", c.algo, c.enc, got)
		}
	}
	// Nested field, custom output, defaults from the descriptor.
	resp := run(t, "hash", map[string]any{"field": "user.email", "outputField": "digest"},
		map[string]any{"user": map[string]any{"email": "hello"}})
	if resp.Outputs[0][0].JSON["digest"] != cases[0].want {
		t.Errorf("nested = %+v", resp.Outputs[0][0].JSON)
	}
	// Missing field → item-specific error.
	resp = run(t, "hash", map[string]any{}, map[string]any{"value": "a"}, map[string]any{"other": 1.0})
	if resp.Error == nil || resp.Error.ItemIndex == nil || *resp.Error.ItemIndex != 1 {
		t.Errorf("missing field error = %+v", resp.Error)
	}
	// LoadOptions.
	opts, err := HashNode{}.LoadOptions("algorithms", nil)
	if err != nil || len(opts) != 4 {
		t.Errorf("LoadOptions = %v %v", opts, err)
	}
	if _, err := (HashNode{}).LoadOptions("nope", nil); err == nil {
		t.Error("unknown method must fail")
	}
}

var uuidV4 = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func TestUUID(t *testing.T) {
	resp := run(t, "uuid", map[string]any{"mode": "addToItems"}, map[string]any{"a": 1.0}, map[string]any{"a": 2.0})
	if len(resp.Outputs[0]) != 2 {
		t.Fatalf("outputs = %+v", resp.Outputs)
	}
	a, b := resp.Outputs[0][0].JSON["uuid"].(string), resp.Outputs[0][1].JSON["uuid"].(string)
	if !uuidV4.MatchString(a) || !uuidV4.MatchString(b) || a == b {
		t.Errorf("uuids %q %q", a, b)
	}

	resp = run(t, "uuid", map[string]any{"mode": "generate", "count": 5.0}, map[string]any{})
	if len(resp.Outputs[0]) != 5 {
		t.Fatalf("generate = %+v", resp.Outputs)
	}
	seen := map[string]bool{}
	for _, it := range resp.Outputs[0] {
		id := it.JSON["uuid"].(string)
		if !uuidV4.MatchString(id) || seen[id] || it.PairedItem == nil || it.PairedItem.Item != 0 {
			t.Errorf("generated item %+v", it)
		}
		seen[id] = true
	}

	resp = run(t, "uuid", map[string]any{"mode": "generate", "count": 0.0})
	if resp.Error == nil {
		t.Error("count 0 must fail")
	}
}

func TestBase64(t *testing.T) {
	resp := run(t, "base64", map[string]any{"operation": "encode"}, map[string]any{"value": "hello world?"})
	if got := resp.Outputs[0][0].JSON["value"]; got != "aGVsbG8gd29ybGQ/" {
		t.Errorf("encode = %v", got)
	}
	resp = run(t, "base64", map[string]any{"operation": "encode", "urlSafe": true, "outputField": "b64"}, map[string]any{"value": "hello world?"})
	if got := resp.Outputs[0][0].JSON["b64"]; got != "aGVsbG8gd29ybGQ_" {
		t.Errorf("urlSafe encode = %v", got)
	}
	for in, want := range map[string]string{"aGVsbG8gd29ybGQ/": "hello world?", "aGVsbG8gd29ybGQ_": "hello world?", "aGVsbG8=": "hello", "aGVsbG8": "hello", " aGVs\nbG8= ": "hello"} {
		resp = run(t, "base64", map[string]any{"operation": "decode"}, map[string]any{"value": in})
		if resp.Error != nil || resp.Outputs[0][0].JSON["value"] != want {
			t.Errorf("decode %q = %+v %+v", in, resp.Outputs, resp.Error)
		}
	}
	resp = run(t, "base64", map[string]any{"operation": "decode"}, map[string]any{"value": "!!!"})
	if resp.Error == nil || *resp.Error.ItemIndex != 0 {
		t.Errorf("invalid base64 error = %+v", resp.Error)
	}
}

func makeJWT(header, payload map[string]any) string {
	h, _ := json.Marshal(header)
	p, _ := json.Marshal(payload)
	return base64.RawURLEncoding.EncodeToString(h) + "." + base64.RawURLEncoding.EncodeToString(p) + ".c2ln"
}

func TestJWTDecode(t *testing.T) {
	defer func(orig func() time.Time) { now = orig }(now)
	now = func() time.Time { return time.Unix(1_700_000_000, 0) }

	past := makeJWT(map[string]any{"alg": "HS256", "typ": "JWT"}, map[string]any{"sub": "42", "exp": 1_600_000_000})
	future := makeJWT(map[string]any{"alg": "RS256"}, map[string]any{"sub": "7", "exp": 1_800_000_000.5})
	noExp := "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"

	resp := run(t, "jwtDecode", map[string]any{}, map[string]any{"token": past}, map[string]any{"token": future}, map[string]any{"token": noExp})
	if resp.Error != nil {
		t.Fatalf("%+v", resp.Error)
	}
	j0 := resp.Outputs[0][0].JSON["jwt"].(map[string]any)
	if j0["expired"] != true || j0["expiresAt"] != "2020-09-13T12:26:40Z" || j0["header"].(map[string]any)["alg"] != "HS256" || j0["signatureVerified"] != false {
		t.Errorf("past = %+v", j0)
	}
	j1 := resp.Outputs[0][1].JSON["jwt"].(map[string]any)
	if j1["expired"] != false || j1["expiresAt"] != "2027-01-15T08:00:00Z" {
		t.Errorf("future = %+v", j1)
	}
	j2 := resp.Outputs[0][2].JSON["jwt"].(map[string]any)
	if j2["expiresAt"] != nil || j2["expired"] != false || j2["payload"].(map[string]any)["name"] != "John Doe" {
		t.Errorf("no exp = %+v", j2)
	}

	resp = run(t, "jwtDecode", map[string]any{}, map[string]any{"token": "not-a-jwt"})
	if resp.Error == nil || *resp.Error.ItemIndex != 0 || !strings.Contains(resp.Error.Description, "3 dot-separated") {
		t.Errorf("invalid token error = %+v", resp.Error)
	}
	d := JWTDecodeNode{}.Description()
	if d.Properties[0].Type != landflow.PropNotice || !strings.Contains(d.Properties[0].DisplayName, "NOT verified") {
		t.Errorf("notice property = %+v", d.Properties[0])
	}
}

func TestHashTelemetry(t *testing.T) {
	p := newPlugin()
	rec := tracetest.NewSpanRecorder()
	reader := sdkmetric.NewManualReader()
	tel, err := p.SetupTelemetry(context.Background(), landflow.TelemetryOptions{
		SpanProcessors: []sdktrace.SpanProcessor{rec}, MetricReaders: []sdkmetric.Reader{reader},
		LogWriter: io.Discard, NoOTLP: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer tel.Shutdown(context.Background())

	req := &landflow.ExecuteRequest{
		Protocol: landflow.ProtocolVersion, ExecutionID: "ex", WorkflowID: "wf", Mode: landflow.ModeManual,
		Node:           landflow.NodeRef{ID: "n", Name: "Hash", Type: "go-crypto.hash", TypeVersion: 1},
		Parameters:     map[string]any{"algorithm": "sha256"},
		ItemParameters: []map[string]any{{"algorithm": "sha256"}, {"algorithm": "md5"}, {"algorithm": "sha256"}},
		Inputs:         [][]landflow.Item{{{JSON: map[string]any{"value": "a"}}, {JSON: map[string]any{"value": "b"}}, {JSON: map[string]any{"value": "c"}}}},
	}
	if resp, err := p.Execute(context.Background(), req); err != nil || resp.Error != nil {
		t.Fatalf("execute: %v %+v", err, resp)
	}

	var server, child sdktrace.ReadOnlySpan
	for _, s := range rec.Ended() {
		switch s.Name() {
		case "plugin.execute go-crypto.hash":
			server = s
		case "crypto.hash":
			child = s
		}
	}
	if server == nil || child == nil || child.Parent().SpanID() != server.SpanContext().SpanID() {
		t.Fatalf("want crypto.hash as a child of plugin.execute go-crypto.hash, got %d spans", len(rec.Ended()))
	}
	for _, kv := range child.Attributes() {
		if kv.Key == "crypto.algorithms" && strings.Join(kv.Value.AsStringSlice(), ",") != "md5,sha256" {
			t.Errorf("crypto.algorithms = %v", kv.Value.AsStringSlice())
		}
	}

	var rm metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &rm); err != nil {
		t.Fatal(err)
	}
	got := map[string]float64{}
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			if m.Name != "crypto.hashes" {
				continue
			}
			for _, dp := range m.Data.(metricdata.Sum[float64]).DataPoints {
				alg, _ := dp.Attributes.Value("crypto.algorithm")
				nodeType, _ := dp.Attributes.Value("landflow.node.type")
				if nodeType.AsString() != "go-crypto.hash" {
					t.Errorf("auto-attribute landflow.node.type = %q", nodeType.AsString())
				}
				got[alg.AsString()] = dp.Value
			}
		}
	}
	if got["sha256"] != 2 || got["md5"] != 1 {
		t.Errorf("crypto.hashes = %v", got)
	}
}
