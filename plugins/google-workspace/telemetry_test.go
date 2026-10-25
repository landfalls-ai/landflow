package main

import (
	"context"
	"strings"
	"testing"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	landflow "github.com/landflow/landflow/sdks/go"
)

// ancestorNamed reports whether span s has an ancestor called name among spans.
func ancestorNamed(s sdktrace.ReadOnlySpan, name string, spans []sdktrace.ReadOnlySpan) bool {
	byID := map[string]sdktrace.ReadOnlySpan{}
	for _, sp := range spans {
		byID[sp.SpanContext().SpanID().String()] = sp
	}
	for p := byID[s.Parent().SpanID().String()]; p != nil; p = byID[p.Parent().SpanID().String()] {
		if p.Name() == name {
			return true
		}
	}
	return false
}

func TestTraceSpans(t *testing.T) {
	h := newHarness(t)
	tel := h.withTelemetry()
	h.leads()
	params := sheetParams("append", nil)
	h.ok(h.exec("googleSheets", params, execOpts{items: []map[string]any{{"Name": "A"}}}))
	h.ok(h.exec("googleSheets", params, execOpts{items: []map[string]any{{"Name": "B"}}}))

	spans := tel.spans.Ended()
	tokens := tel.spansNamed("google.oauth.token")
	if len(tokens) < 2 {
		t.Fatalf("%d google.oauth.token spans", len(tokens))
	}
	hits := map[string]int{}
	for _, s := range tokens {
		hit, _ := spanAttr(s, "landflow.cache_hit")
		hits[hit]++
		if auth, _ := spanAttr(s, "google.auth"); auth != "service_account" {
			t.Errorf("google.auth = %q", auth)
		}
		if !ancestorNamed(s, "plugin.execute google.googleSheets", spans) {
			t.Errorf("google.oauth.token is not inside plugin.execute google.googleSheets")
		}
	}
	if hits["false"] != 1 || hits["true"] < 1 {
		t.Errorf("cache_hit counts = %v, want one exchange and cache hits after", hits)
	}
	if got := tel.counter(t, "landflow.google.token_refreshes", map[string]string{"auth": "service_account", "outcome": "success"}); got != 1 {
		t.Errorf("token_refreshes{service_account,success} = %v", got)
	}

	// The token exchange and every API call are HTTP client spans of the run.
	var posts, gets int
	for _, s := range tel.spansNamed("HTTP *") {
		if !ancestorNamed(s, "plugin.execute google.googleSheets", spans) {
			t.Errorf("%s is outside the execution's trace", s.Name())
		}
		switch s.Name() {
		case "HTTP POST":
			posts++
		case "HTTP GET":
			gets++
		}
	}
	if posts < 3 || gets < 2 { // token + 2 appends; 2 header reads
		t.Errorf("HTTP spans: %d POST, %d GET", posts, gets)
	}
	if len(tel.spansNamed("google.sheets.read")) != 2 {
		t.Errorf("google.sheets.read spans = %d", len(tel.spansNamed("google.sheets.read")))
	}
}

func TestTokenRefreshFailureTelemetry(t *testing.T) {
	h := newHarness(t)
	tel := h.withTelemetry()
	creds := h.oauth()
	creds["refreshToken"] = "revoked-refresh-token"
	resp := h.exec("gmail", map[string]any{"authentication": "oAuth2", "resource": "message", "operation": "getAll", "limit": 1},
		execOpts{creds: map[string]any{credOAuth2: creds}})
	if resp.Error == nil || !strings.Contains(resp.Error.Message, "Google rejected the OAuth2 credential (HTTP 400 invalid_grant)") {
		t.Fatalf("error = %+v", resp.Error)
	}
	if got := tel.counter(t, "landflow.google.token_refreshes", map[string]string{"auth": "oauth2", "outcome": "error"}); got != 1 {
		t.Errorf("token_refreshes{oauth2,error} = %v", got)
	}
	tokens := tel.spansNamed("google.oauth.token")
	if len(tokens) != 1 || tokens[0].Status().Code.String() != "Error" {
		t.Errorf("token span status = %+v", tokens)
	}

	// Credential tests trace the exchange inside plugin.test_credentials.
	if _, err := h.plugin.TestCredentials(context.Background(), &landflow.TestCredentialsRequest{CredentialType: credServiceAccount, Data: h.sa()}); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, s := range tel.spansNamed("google.oauth.token") {
		found = found || ancestorNamed(s, "plugin.test_credentials googleApi", tel.spans.Ended())
	}
	if !found {
		t.Error("no google.oauth.token span under plugin.test_credentials googleApi")
	}
}

// TestNoSecretsInTelemetry runs every credential path and checks that no
// key material, client secret, refresh token, assertion or access token
// shows up in span names, attributes, events or logs.
func TestNoSecretsInTelemetry(t *testing.T) {
	h := newHarness(t)
	tel := h.withTelemetry()
	h.leads()
	sa, oauth := h.sa(), h.oauth()
	pemBody := strings.Split(sa["privateKey"].(string), "\n")[1]

	h.ok(h.exec("googleSheets", sheetParams("read", nil), execOpts{}))
	h.ok(h.exec("googleSheets", sheetParams("read", map[string]any{"authentication": "oAuth2"}), execOpts{creds: map[string]any{credOAuth2: oauth}}))
	h.fake.RevokeTokens() // force the 401 → refresh path
	h.ok(h.exec("googleSheets", sheetParams("read", nil), execOpts{}))
	bad := h.oauth()
	bad["refreshToken"] = "revoked-refresh-token-xyz"
	h.exec("googleSheets", sheetParams("read", map[string]any{"authentication": "oAuth2"}), execOpts{creds: map[string]any{credOAuth2: bad}})
	for _, ct := range []struct {
		name string
		data map[string]any
	}{{credServiceAccount, sa}, {credOAuth2, oauth}, {credOAuth2, bad}} {
		if _, err := h.plugin.TestCredentials(context.Background(), &landflow.TestCredentialsRequest{CredentialType: ct.name, Data: ct.data}); err != nil {
			t.Fatal(err)
		}
	}

	var dump strings.Builder
	for _, s := range tel.spans.Ended() {
		dump.WriteString(s.Name() + "\n")
		for _, kv := range s.Attributes() {
			dump.WriteString(string(kv.Key) + "=" + kv.Value.Emit() + "\n")
		}
		for _, ev := range s.Events() {
			dump.WriteString(ev.Name + "\n")
			for _, kv := range ev.Attributes {
				dump.WriteString(string(kv.Key) + "=" + kv.Value.Emit() + "\n")
			}
		}
		dump.WriteString(s.Status().Description + "\n")
	}
	logMu.Lock()
	dump.WriteString(tel.logs.String())
	logMu.Unlock()
	text := dump.String()
	if !strings.Contains(text, "google.oauth.token") || !strings.Contains(text, "HTTP POST") {
		t.Fatalf("telemetry looks empty:\n%.500s", text)
	}
	for name, secret := range map[string]string{
		"private key":   pemBody,
		"PEM header":    "BEGIN PRIVATE KEY",
		"client secret": "oauth-client-secret-1",
		"refresh token": "oauth-refresh-token-1",
		"bad refresh":   "revoked-refresh-token-xyz",
		"access token":  "ya29.",
		"JWT assertion": "eyJhbGciOiJSUzI1NiIs",
		"form body":     "grant_type=",
		"bearer header": "Bearer ",
	} {
		if strings.Contains(text, secret) {
			t.Errorf("%s leaked into telemetry", name)
		}
	}
}
