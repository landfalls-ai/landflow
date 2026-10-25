package landflow

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	grpccodes "google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	pb "github.com/landflow/landflow/sdks/go/landflowpb"
)

func attributeKey(k string) attribute.Key { return attribute.Key(k) }

func TestCredentialManifest(t *testing.T) {
	p := credPlugin()
	m := p.Manifest()
	if len(m.CredentialTypes) != 2 || m.CredentialTypes[0].Name != "demoApi" || !m.CredentialTypes[0].Testable || m.CredentialTypes[1].Testable {
		t.Fatalf("credentialTypes = %+v", m.CredentialTypes)
	}
	data, _ := json.Marshal(m)
	var raw map[string]any
	_ = json.Unmarshal(data, &raw)
	ct := raw["credentialTypes"].([]any)[0].(map[string]any)
	prop := ct["properties"].([]any)[0].(map[string]any)
	if ct["testable"] != true || ct["documentationUrl"] != "https://example.invalid/docs" || prop["typeOptions"].(map[string]any)["password"] != true {
		t.Errorf("credential type JSON = %v", ct)
	}
	send := raw["nodes"].([]any)[0].(map[string]any)
	if creds := send["credentials"].([]any); len(creds) != 1 || creds[0].(map[string]any)["name"] != "demoApi" || creds[0].(map[string]any)["required"] != true {
		t.Errorf("node credentials = %v", send["credentials"])
	}
	if p.WellKnown().Endpoints.TestCredentials != PathTestCredentials {
		t.Error("well-known lacks testCredentials")
	}
	if p.Info().CredentialTypes != nil {
		t.Error("PluginInfo.CredentialTypes should be cleared")
	}

	// gRPC: credential_types travel as JSON.
	client := bufconnClient(t, p)
	resp, err := client.GetManifest(context.Background(), &pb.GetManifestRequest{})
	if err != nil {
		t.Fatal(err)
	}
	var d CredentialTypeDescriptor
	if len(resp.GetCredentialTypes()) != 2 || json.Unmarshal(resp.GetCredentialTypes()[0].GetJson(), &d) != nil || d.Name != "demoApi" || !d.Testable {
		t.Errorf("gRPC credential_types = %v", resp.GetCredentialTypes())
	}

	// A plugin without credential types omits the field.
	data, _ = json.Marshal(testPlugin().Manifest())
	if strings.Contains(string(data), "credentialTypes") {
		t.Error("empty credentialTypes should be omitted")
	}
}

func TestIsSecretKey(t *testing.T) {
	for _, key := range []string{"accessToken", "refresh_token", "apiKey", "clientSecret", "authorization", "password"} {
		if !IsSecretKey(key) {
			t.Errorf("IsSecretKey(%q) = false", key)
		}
	}
	for _, key := range []string{"tokenUrl", "token_uri", "tokenEndpoint", "tokenType", "baseUrl", "host"} {
		if IsSecretKey(key) {
			t.Errorf("IsSecretKey(%q) = true", key)
		}
	}
}

func TestCredentialValidation(t *testing.T) {
	_, err := BuildPlugin(PluginInfo{ID: "x", Name: "X", Version: "1",
		CredentialTypes: []CredentialType{
			{Name: "bad name", Properties: []PropertyDescriptor{{Name: "a", Type: "nope"}}},
			{Name: "dup", DisplayName: "Dup"}, {Name: "dup", DisplayName: "Dup"},
		}},
		nodeFunc{d: NodeDescriptor{Name: "n", DisplayName: "N", Credentials: []NodeCredentialRequirement{{Name: "missing"}, {Name: "dup"}, {Name: "dup"}}}},
	)
	if err == nil {
		t.Fatal("expected validation errors")
	}
	for _, want := range []string{
		`name "bad name" must be an identifier`, "displayName is required", `properties[a].type "nope"`,
		"duplicate credential type name", `credentials[0] "missing" is not one of the plugin's credential types`,
		`credentials[2] "dup" is listed twice`,
	} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("missing problem %q in:\n%v", want, err)
		}
	}
}

// nodeFunc is a node built from a descriptor and an optional func.
type nodeFunc struct {
	d  NodeDescriptor
	fn func(*ExecuteContext) ([][]Item, error)
}

func (n nodeFunc) Description() NodeDescriptor { return n.d }
func (n nodeFunc) Execute(ctx *ExecuteContext) ([][]Item, error) {
	if n.fn == nil {
		return nil, nil
	}
	return n.fn(ctx)
}

func TestCredentialAccessors(t *testing.T) {
	req := &ExecuteRequest{Credentials: map[string]any{
		"demoApi": map[string]any{"accessToken": "t", "port": "5432", "tls": "true", "ratio": 0.5},
	}}
	ctx := NewExecuteContext(context.Background(), req, nil)
	if ctx.Credentials("demoApi").String("accessToken") != "t" || ctx.CredentialString("demoApi", "accessToken") != "t" {
		t.Error("string accessors")
	}
	if ctx.CredentialInt("demoApi", "port", 0) != 5432 || !ctx.CredentialBool("demoApi", "tls", false) ||
		ctx.Credentials("demoApi").Float("ratio", 0) != 0.5 || ctx.Credentials("demoApi").StringOr("host", "localhost") != "localhost" {
		t.Error("typed accessors")
	}
	if ctx.Credentials("other") != nil || ctx.CredentialString("other", "x") != "" || ctx.HasCredentials("other") || !ctx.HasCredentials("demoApi") {
		t.Error("missing credentials should be empty")
	}
	if all := ctx.Credentials(); all["demoApi"] == nil {
		t.Error("Credentials() without a name returns every credential")
	}
	if _, err := ctx.RequireCredentials("other"); err == nil || errorPayload(err).Message != `Credentials of type "other" are required` {
		t.Errorf("RequireCredentials error = %v", err)
	}
}

func TestExecuteWithCredentials(t *testing.T) {
	p := credPlugin()
	echo := newEchoServer(t)
	resp, err := p.Execute(context.Background(), sendReq(echo.URL, fakeToken, false))
	if err != nil || resp.Error != nil {
		t.Fatalf("execute: %v %+v", err, resp.Error)
	}
	if out := resp.Outputs[0][0].JSON; out["user"] != "ada" || out["status"] != http.StatusTeapot {
		t.Errorf("output = %v", out)
	}
	// Missing credentials: a user-facing node error.
	req := execReq("cred-plugin.send", map[string]any{}, map[string]any{})
	resp, _ = p.Execute(context.Background(), req)
	if resp.Error == nil || !strings.Contains(resp.Error.Message, `"demoApi" are required`) {
		t.Errorf("missing credentials error = %+v", resp.Error)
	}
}

func TestLoadOptionsWithCredentials(t *testing.T) {
	h := newTelHarness(t, credPlugin())
	creds := map[string]any{"demoApi": map[string]any{"user": "ada", "accessToken": fakeToken}}

	// HTTP
	srv := httptest.NewServer(h.p.Handler())
	defer srv.Close()
	code, body := postJSON(t, srv.URL+PathLoadOptions, LoadOptionsRequest{NodeType: "pick", Method: "channels", Credentials: creds},
		http.Header{"Traceparent": {testTraceHdr}})
	if code != 200 || !strings.Contains(string(body), `"#general (ada)"`) {
		t.Fatalf("HTTP load-options: %d %s", code, body)
	}
	s := h.span(t, "plugin.load_options channels")
	a := attrs(s.Attributes())
	if s.Parent().SpanID().String() != testParent || a["landflow.load_options.method"] != "channels" ||
		a["landflow.node.type"] != "cred-plugin.pick" || a["landflow.plugin.id"] != "cred-plugin" {
		t.Errorf("load_options span: parent=%s attrs=%v", s.Parent().SpanID(), a)
	}
	if h.span(t, "demo.list_channels").Parent().SpanID() != s.SpanContext().SpanID() {
		t.Error("custom span inside LoadOptions is not a child of the server span")
	}

	// gRPC
	client := bufconnClient(t, h.p)
	dv, _ := Dynamic(creds)
	resp, err := client.LoadOptions(context.Background(), &pb.LoadOptionsRequest{NodeType: "pick", Method: "channels", Credentials: dv})
	if err != nil || !strings.Contains(string(resp.GetOptions().GetJson()), "ada") {
		t.Fatalf("gRPC load-options: %v %s", err, resp.GetOptions().GetJson())
	}
	// Without credentials the loader fails: error status and outcome=error.
	if _, err := client.LoadOptions(context.Background(), &pb.LoadOptionsRequest{NodeType: "pick", Method: "channels"}); status.Code(err) != grpccodes.InvalidArgument {
		t.Errorf("gRPC load-options without credentials: %v", err)
	}
	failed := h.spans("plugin.load_options channels")
	if last := failed[len(failed)-1]; last.Status().Code != codes.Error {
		t.Errorf("failed load_options status = %v", last.Status())
	}
}

func TestTestCredentialsHTTP(t *testing.T) {
	h := newTelHarness(t, credPlugin())
	srv := httptest.NewServer(h.p.Handler())
	defer srv.Close()
	echo := newEchoServer(t)

	call := func(body TestCredentialsRequest) (int, TestCredentialsResponse) {
		code, data := postJSON(t, srv.URL+PathTestCredentials, body, http.Header{"Traceparent": {testTraceHdr}})
		var out TestCredentialsResponse
		_ = json.Unmarshal(data, &out)
		return code, out
	}
	code, ok := call(TestCredentialsRequest{CredentialType: "demoApi", Data: map[string]any{"accessToken": goodToken, "baseUrl": echo.URL}})
	if code != 200 || !ok.OK || ok.Message != "" {
		t.Errorf("good token: %d %+v", code, ok)
	}
	code, bad := call(TestCredentialsRequest{CredentialType: "demoApi", Data: map[string]any{"accessToken": fakeToken}})
	if code != 200 || bad.OK || bad.Message != "invalid token "+fakeToken {
		t.Errorf("bad token: %d %+v", code, bad)
	}
	code, plain := call(TestCredentialsRequest{CredentialType: "plainApi", Data: map[string]any{}})
	if code != 200 || plain.OK || !strings.Contains(plain.Message, "no connection test") {
		t.Errorf("not testable: %d %+v", code, plain)
	}
	if code, _ := call(TestCredentialsRequest{CredentialType: "nope"}); code != http.StatusNotFound {
		t.Errorf("unknown type: %d", code)
	}
	if code, _ := call(TestCredentialsRequest{}); code != http.StatusBadRequest {
		t.Errorf("missing type: %d", code)
	}

	spans := h.spans("plugin.test_credentials demoApi")
	if len(spans) != 2 {
		t.Fatalf("test_credentials spans = %d", len(spans))
	}
	good, failed := spans[0], spans[1]
	if a := attrs(good.Attributes()); a["landflow.credential.ok"] != true || a["landflow.credential.type"] != "demoApi" ||
		a["landflow.plugin.id"] != "cred-plugin" || good.Parent().SpanID().String() != testParent {
		t.Errorf("good span attrs = %v", a)
	}
	if attrs(failed.Attributes())["landflow.credential.ok"] != false || failed.Status().Code != codes.Error ||
		failed.Status().Description != "invalid token "+Redacted {
		t.Errorf("failed span: %v %v", failed.Attributes(), failed.Status())
	}
	// Test's HTTP call is a child of the server span and carries traceparent.
	if h.span(t, "HTTP GET").Parent().SpanID() != good.SpanContext().SpanID() || echo.lastParent() == "" {
		t.Error("credential test HTTP call is not traced")
	}
	mustNotContain(t, "logs", h.logs.String(), fakeToken, goodToken)
}

func TestTestCredentialsGRPC(t *testing.T) {
	h := newTelHarness(t, credPlugin())
	client := bufconnClient(t, h.p)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ctx = metadata.AppendToOutgoingContext(ctx, "traceparent", testTraceHdr)

	good, _ := Dynamic(map[string]any{"accessToken": goodToken})
	resp, err := client.TestCredentials(ctx, &pb.TestCredentialsRequest{CredentialType: "demoApi", Data: good})
	if err != nil || !resp.GetOk() {
		t.Fatalf("good: %v %v", err, resp)
	}
	bad, _ := Dynamic(map[string]any{"accessToken": "wrong-FAKE"})
	resp, err = client.TestCredentials(ctx, &pb.TestCredentialsRequest{CredentialType: "cred-plugin.demoApi", Data: bad})
	if err != nil || resp.GetOk() || resp.GetMessage() != "invalid token wrong-FAKE" {
		t.Errorf("bad: %v %v", err, resp)
	}
	if _, err := client.TestCredentials(ctx, &pb.TestCredentialsRequest{CredentialType: "nope"}); status.Code(err) != grpccodes.NotFound {
		t.Errorf("unknown type: %v", err)
	}
	if _, err := client.TestCredentials(ctx, &pb.TestCredentialsRequest{CredentialType: "demoApi", Data: &pb.DynamicValue{Json: []byte("[1]")}}); status.Code(err) != grpccodes.InvalidArgument {
		t.Errorf("bad data: %v", err)
	}
	spans := h.spans("plugin.test_credentials demoApi")
	if len(spans) != 2 || spans[0].Parent().SpanID().String() != testParent {
		t.Errorf("gRPC test_credentials spans = %d", len(spans))
	}
}

func TestRedaction(t *testing.T) {
	h := newTelHarness(t, credPlugin())
	echo := newEchoServer(t)
	srv := httptest.NewServer(h.p.Handler())
	defer srv.Close()

	code, body := postJSON(t, srv.URL+PathExecute, sendReq(echo.URL, fakeToken, true), nil)
	if code != 200 {
		t.Fatal(code)
	}
	var resp ExecuteResponse
	_ = json.Unmarshal(body, &resp)

	// Node logs returned to the host are masked; the error message itself is
	// the node's (returned to the host unchanged).
	logsJSON, _ := json.Marshal(resp.Logs)
	mustNotContain(t, "returned logs", string(logsJSON), fakeToken, "k-FAKE-55555")
	if !strings.Contains(string(logsJSON), "with token "+Redacted) || !strings.Contains(string(logsJSON), "api_key="+Redacted) {
		t.Errorf("returned logs = %s", logsJSON)
	}
	if resp.Error == nil || !strings.Contains(resp.Error.Message, fakeToken) {
		t.Errorf("response error = %+v", resp.Error)
	}

	// Process logs (node lines + span.end lines) never contain the token.
	mustNotContain(t, "process logs", h.logs.String(), fakeToken, "k-FAKE-55555", "Bearer abc")

	// Span attributes, statuses and events never contain the token.
	for _, s := range h.rec.Ended() {
		var all []string
		for _, kv := range s.Attributes() {
			all = append(all, string(kv.Key)+"="+kv.Value.Emit())
		}
		for _, e := range s.Events() {
			for _, kv := range e.Attributes {
				all = append(all, kv.Value.Emit())
			}
		}
		all = append(all, s.Status().Description)
		mustNotContain(t, "span "+s.Name(), strings.Join(all, " "), fakeToken, "Bearer abc")
	}
	a := attrs(h.span(t, "demo.send").Attributes())
	if a["demo.token_used"] != Redacted || a["authorization"] != Redacted || a["demo.count"] != int64(3) {
		t.Errorf("custom span attributes = %v", a)
	}
	server := h.span(t, "plugin.execute cred-plugin.send")
	if server.Status().Description != "request to "+echo.URL+"/bot"+Redacted+" failed" {
		t.Errorf("server span status = %q", server.Status().Description)
	}
	// The request still reached the API with the real token.
	if len(echo.paths) != 1 || !strings.Contains(echo.paths[0], fakeToken) {
		t.Errorf("echo paths = %v", echo.paths)
	}
	if RedactString(context.Background(), fakeToken) != fakeToken {
		t.Error("RedactString without a call scope must not change the string")
	}
}
