package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	landflow "github.com/landflow/landflow/sdks/go"
)

func TestManifest(t *testing.T) {
	m := newPlugin().Manifest()
	const svgIcon = "data:image/svg+xml;base64,"
	if m.Plugin.ID != "google" || m.Plugin.Name != "Google Workspace" || m.Plugin.Language != "go" ||
		!strings.HasPrefix(m.Plugin.Icon, svgIcon) {
		t.Errorf("plugin info = %.200v", m.Plugin)
	}
	want := map[string]landflow.NodeKind{
		"googleSheets": landflow.KindAction, "googleSheetsTrigger": landflow.KindTrigger,
		"gmail": landflow.KindAction, "gmailTrigger": landflow.KindTrigger,
		"googleDrive": landflow.KindAction, "googleCalendar": landflow.KindAction, "googleDocs": landflow.KindAction,
		"googleDriveTrigger": landflow.KindTrigger, "googleCalendarTrigger": landflow.KindTrigger, "googleDirectory": landflow.KindAction,
	}
	if len(m.Nodes) != len(want) {
		t.Errorf("%d nodes, want %d", len(m.Nodes), len(want))
	}
	for _, d := range m.Nodes {
		kind, ok := want[d.Name]
		if !ok {
			t.Errorf("unexpected node %q", d.Name)
			continue
		}
		if d.Kind != kind {
			t.Errorf("%s kind = %q, want %q", d.Name, d.Kind, kind)
		}
		if !strings.HasPrefix(d.Icon, svgIcon) {
			t.Errorf("%s icon = %.60q, want an embedded SVG", d.Name, d.Icon)
		}
		var creds []string
		for _, c := range d.Credentials {
			creds = append(creds, c.Name)
		}
		if !slices.Equal(creds, []string{credServiceAccount, credOAuth2}) {
			t.Errorf("%s credentials = %v", d.Name, creds)
		}
	}

	secrets := map[string][]string{credServiceAccount: {"privateKey"}, credOAuth2: {"clientSecret", "refreshToken"}}
	if len(m.CredentialTypes) != 2 {
		t.Fatalf("credential types = %+v", m.CredentialTypes)
	}
	for _, ct := range m.CredentialTypes {
		if !ct.Testable {
			t.Errorf("%s is not testable", ct.Name)
		}
		var password []string
		names := map[string]bool{}
		for _, p := range ct.Properties {
			names[p.Name] = true
			if p.TypeOptions != nil && p.TypeOptions.Password {
				password = append(password, p.Name)
			}
		}
		if !slices.Equal(password, secrets[ct.Name]) {
			t.Errorf("%s password fields = %v, want %v", ct.Name, password, secrets[ct.Name])
		}
		tokenField := map[string]string{credServiceAccount: "tokenUrl", credOAuth2: "accessTokenUrl"}[ct.Name]
		if !names[tokenField] || !names["baseUrl"] {
			t.Errorf("%s lacks %s/baseUrl", ct.Name, tokenField)
		}
	}
	// The OAuth2 type extends the host's generic one (Connect) and pins the flow to Google.
	oauth := m.CredentialTypes[1]
	if !slices.Equal(oauth.Extends, []string{"oAuth2Api"}) {
		t.Errorf("%s extends = %v", oauth.Name, oauth.Extends)
	}
	hidden := map[string]any{}
	for _, p := range oauth.Properties {
		if p.Type == landflow.PropHidden {
			hidden[p.Name] = p.Default
		}
	}
	wantHidden := map[string]any{"grantType": "pkce", "authUrl": googleAuthURL, "authQueryParameters": googleAuthQuery, "authentication": "body", "userInfoUrl": googleUserInfoURL}
	if fmt.Sprint(hidden) != fmt.Sprint(wantHidden) {
		t.Errorf("hidden OAuth2 fields = %v, want %v", hidden, wantHidden)
	}
}

func TestServiceAccountJWT(t *testing.T) {
	h := newHarness(t)
	fixed := time.Date(2026, 10, 25, 9, 0, 0, 0, time.UTC)
	now = func() time.Time { return fixed }
	t.Cleanup(func() { now = time.Now })

	ts, err := newTokenSource(credServiceAccount, h.sa())
	if err != nil {
		t.Fatal(err)
	}
	token, resp, err := ts.Token(context.Background(), nil, false)
	if err != nil || token == "" || resp == nil {
		t.Fatalf("token = %q, %v", token, err)
	}
	ex := h.fake.ExchangeList()
	if len(ex) != 1 || ex[0].GrantType != jwtBearerGrant {
		t.Fatalf("exchanges = %+v", ex)
	}
	// The fake verified the signature with the public key; check the claims.
	c := ex[0].Claims
	if c["iss"] != saEmail || c["sub"] != "me@example.com" || c["aud"] != h.url+"/token" ||
		c["iat"] != float64(fixed.Unix()) || c["exp"] != float64(fixed.Add(time.Hour).Unix()) {
		t.Errorf("claims = %v", c)
	}
	if got := strings.Fields(c["scope"].(string)); !slices.Equal(got, googleScopes) {
		t.Errorf("scope = %v", got)
	}

	// Cached until 60 s before expiry.
	now = func() time.Time { return fixed.Add(58 * time.Minute) }
	if again, resp, _ := ts.Token(context.Background(), nil, false); again != token || resp != nil {
		t.Errorf("token not cached: %q vs %q", again, token)
	}
	now = func() time.Time { return fixed.Add(59*time.Minute + 30*time.Second) }
	if again, _, _ := ts.Token(context.Background(), nil, false); again == token {
		t.Error("token not refreshed inside the expiry margin")
	}
	if n := len(h.fake.ExchangeList()); n != 2 {
		t.Errorf("%d exchanges, want 2", n)
	}
}

func TestTokenCacheSharedAcrossExecutions(t *testing.T) {
	h := newHarness(t)
	params := map[string]any{"resource": "event", "operation": "getAll", "calendar": "primary", "returnAll": true}
	for range 3 {
		h.ok(h.exec("googleCalendar", params, execOpts{}))
	}
	if n := len(h.fake.ExchangeList()); n != 1 {
		t.Errorf("%d token exchanges for 3 executions, want 1", n)
	}
}

func TestUnauthorizedRetriesOnce(t *testing.T) {
	h := newHarness(t)
	params := map[string]any{"resource": "event", "operation": "getAll", "calendar": "primary", "returnAll": true}
	h.ok(h.exec("googleCalendar", params, execOpts{}))
	h.fake.RevokeTokens() // the cached token is now rejected with 401
	h.ok(h.exec("googleCalendar", params, execOpts{}))
	if n := len(h.fake.ExchangeList()); n != 2 {
		t.Errorf("%d exchanges, want 2 (initial + after the 401)", n)
	}
	// A second 401 is reported, not retried forever.
	h.fake.Fail(http.MethodGet, "/events", http.StatusUnauthorized, "Request had invalid authentication credentials.")
	h.fake.Fail(http.MethodGet, "/events", http.StatusUnauthorized, "Request had invalid authentication credentials.")
	resp := h.exec("googleCalendar", params, execOpts{})
	if !strings.Contains(errorText(resp), "Google Calendar API error 401: Request had invalid authentication credentials.") {
		t.Errorf("error = %s", errorText(resp))
	}
}

func TestParsePrivateKeyVariants(t *testing.T) {
	key := testKey()
	pkcs8 := pemPKCS8(key)
	pkcs1 := string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))
	keyFile, _ := json.Marshal(map[string]string{"type": "service_account", "client_email": saEmail, "private_key": pkcs8})
	cases := map[string]string{
		"pkcs8":       pkcs8,
		"pkcs1":       pkcs1,
		"escaped":     strings.ReplaceAll(pkcs8, "\n", `\n`),
		"single line": strings.ReplaceAll(pkcs8, "\n", " "),
		"no newlines": strings.ReplaceAll(pkcs8, "\n", ""),
		"key file":    string(keyFile),
		"padded":      "\n  " + pkcs8 + "  \n",
	}
	for name, raw := range cases {
		got, err := parsePrivateKey(raw)
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		if !got.Equal(key) {
			t.Errorf("%s: parsed a different key", name)
		}
	}
	if email := keyFileField(string(keyFile), "client_email"); email != saEmail {
		t.Errorf("client_email from key file = %q", email)
	}

	bad := map[string]string{
		"":                                 "required",
		"MIIEvQIBADANBgkqhkiG9w0BAQEFAASC": "not PEM-encoded",
		"-----BEGIN PRIVATE KEY-----\nabc": "no -----END",
		"-----BEGIN PRIVATE KEY-----\n!!!\n-----END PRIVATE KEY-----":                      "not base64",
		"-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----": "encrypted",
		"-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----":                     "could not be parsed",
	}
	for raw, want := range bad {
		if _, err := parsePrivateKey(raw); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("parsePrivateKey(%.40q) = %v, want %q", raw, err, want)
		}
	}
}

func TestCredentialTests(t *testing.T) {
	h := newHarness(t)
	test := func(credType string, data map[string]any) (bool, string) {
		t.Helper()
		resp, err := h.plugin.TestCredentials(context.Background(), &landflow.TestCredentialsRequest{CredentialType: credType, Data: data})
		if err != nil {
			t.Fatal(err)
		}
		return resp.OK, resp.Message
	}

	ok, msg := test(credServiceAccount, h.sa())
	if !ok || msg != "Token issued for "+saEmail+" with 5 scopes, impersonating me@example.com" {
		t.Errorf("service account test = %v %q", ok, msg)
	}

	// A key that is not the service account's: Google's reason plus a hint.
	other, _ := rsa.GenerateKey(rand.Reader, 2048)
	data := h.sa()
	data["privateKey"] = pemPKCS8(other)
	ok, msg = test(credServiceAccount, data)
	if ok || !strings.Contains(msg, "HTTP 400 invalid_grant): Invalid JWT Signature.") || !strings.Contains(msg, "private key belongs") {
		t.Errorf("wrong key test = %v %q", ok, msg)
	}
	data = h.sa()
	data["email"] = "someone-else@test-project.iam.gserviceaccount.com"
	if ok, msg = test(credServiceAccount, data); ok || !strings.Contains(msg, "Invalid email or User ID") {
		t.Errorf("wrong email test = %v %q", ok, msg)
	}
	data = h.sa()
	data["privateKey"] = "not a key"
	if ok, msg = test(credServiceAccount, data); ok || !strings.Contains(msg, "not PEM-encoded") {
		t.Errorf("garbage key test = %v %q", ok, msg)
	}
	data = h.sa()
	data["tokenUrl"] = "ftp://example.com"
	if ok, msg = test(credServiceAccount, data); ok || !strings.Contains(msg, "http(s) URL") {
		t.Errorf("bad token URL test = %v %q", ok, msg)
	}

	ok, msg = test(credOAuth2, h.oauth())
	if !ok || msg != "Authenticated as me@example.com (4 scopes granted)" {
		t.Errorf("oauth2 test = %v %q", ok, msg)
	}
	data = h.oauth()
	data["refreshToken"] = "revoked-refresh-token"
	ok, msg = test(credOAuth2, data)
	if ok || !strings.Contains(msg, "HTTP 400 invalid_grant): Token has been expired or revoked.") || !strings.Contains(msg, "create a new one") {
		t.Errorf("revoked refresh token test = %v %q", ok, msg)
	}
	if strings.Contains(msg, "revoked-refresh-token") {
		t.Error("the refresh token leaked into the message")
	}
	data = h.oauth()
	data["clientSecret"] = "wrong"
	if ok, msg = test(credOAuth2, data); ok || !strings.Contains(msg, "HTTP 401 invalid_client") {
		t.Errorf("wrong client secret test = %v %q", ok, msg)
	}
	data = h.oauth()
	delete(data, "refreshToken")
	if ok, msg = test(credOAuth2, data); ok || !strings.Contains(msg, "not connected: Connect it in Credentials") {
		t.Errorf("missing refresh token test = %v %q", ok, msg)
	}

	// A Connected credential: the host's access token, no exchange here.
	connected := h.connected()
	exchanges := len(h.fake.ExchangeList())
	if ok, msg = test(credOAuth2, connected); !ok || msg != "Connected as me@example.com" {
		t.Errorf("connected test = %v %q", ok, msg)
	}
	if n := len(h.fake.ExchangeList()) - exchanges; n != 0 {
		t.Errorf("%d exchanges testing a host token, want 0", n)
	}
	h.fake.RevokeTokens()
	if ok, msg = test(credOAuth2, connected); ok || !strings.Contains(msg, "HTTP 401") || !strings.Contains(msg, "reconnect") {
		t.Errorf("revoked host token test = %v %q", ok, msg)
	}

	// Tests bypass the cache: each one is a real exchange.
	before := len(h.fake.ExchangeList())
	test(credServiceAccount, h.sa())
	test(credServiceAccount, h.sa())
	if n := len(h.fake.ExchangeList()) - before; n != 2 {
		t.Errorf("%d exchanges for 2 credential tests, want 2", n)
	}
}

func TestOAuth2Credential(t *testing.T) {
	h := newHarness(t)
	creds := map[string]any{credOAuth2: h.oauth()}
	params := map[string]any{"authentication": "oAuth2", "resource": "message", "operation": "getAll", "limit": 5}
	h.ok(h.exec("gmail", params, execOpts{creds: creds}))
	ex := h.fake.ExchangeList()
	if len(ex) != 1 || ex[0].GrantType != "refresh_token" {
		t.Errorf("exchanges = %+v", ex)
	}

	// Authentication says OAuth2 but only a service account is attached:
	// the node uses what it has.
	h.ok(h.exec("gmail", params, execOpts{}))

	resp := h.exec("gmail", params, execOpts{creds: map[string]any{}})
	if !strings.Contains(errorText(resp), `Credentials of type "googleOAuth2Api" are required`) {
		t.Errorf("missing credential error = %s", errorText(resp))
	}
}

func TestHostAccessToken(t *testing.T) {
	h := newHarness(t)
	params := map[string]any{"authentication": "oAuth2", "resource": "message", "operation": "getAll", "limit": 5}
	connected := h.connected()
	before := len(h.fake.ExchangeList())
	h.ok(h.exec("gmail", params, execOpts{creds: map[string]any{credOAuth2: connected}}))
	if n := len(h.fake.ExchangeList()) - before; n != 0 {
		t.Errorf("%d exchanges with a host token, want 0", n)
	}

	// Google refuses it: the 401 goes back to the host (which renews the token and runs the node again), without a
	// second call or an exchange here.
	h.fake.RevokeTokens()
	calls := len(h.fake.Calls(http.MethodGet, "/gmail/v1/users/me/messages"))
	resp := h.exec("gmail", params, execOpts{creds: map[string]any{credOAuth2: connected}})
	if text := errorText(resp); !strings.Contains(text, "Gmail API error 401") {
		t.Errorf("revoked host token error = %s", text)
	}
	if n := len(h.fake.Calls(http.MethodGet, "/gmail/v1/users/me/messages")) - calls; n != 1 {
		t.Errorf("%d calls after a 401 to the host token, want 1", n)
	}
	if n := len(h.fake.ExchangeList()) - before; n != 0 {
		t.Errorf("%d exchanges after a 401 to the host token, want 0", n)
	}

	// With a refresh token entered by hand as well, the plugin renews the token itself.
	connected["refreshToken"] = "oauth-refresh-token-1"
	h.ok(h.exec("gmail", params, execOpts{creds: map[string]any{credOAuth2: connected}}))
	if ex := h.fake.ExchangeList()[before:]; len(ex) != 1 || ex[0].GrantType != "refresh_token" {
		t.Errorf("exchanges = %+v", ex)
	}
}

func TestOAuth2TokenURL(t *testing.T) {
	for _, c := range []struct {
		data landflow.CredentialData
		want string
	}{
		{landflow.CredentialData{}, defaultTokenURL},
		{landflow.CredentialData{"accessTokenUrl": defaultTokenURL}, defaultTokenURL},
		{landflow.CredentialData{"accessTokenUrl": "http://fake/token"}, "http://fake/token"},
		// Saved before accessTokenUrl existed: the host fills that one with its default.
		{landflow.CredentialData{"accessTokenUrl": defaultTokenURL, "tokenUrl": "http://old/token"}, "http://old/token"},
		{landflow.CredentialData{"accessTokenUrl": "http://new/token", "tokenUrl": "http://old/token"}, "http://new/token"},
	} {
		if got := oauth2TokenURL(c.data); got != c.want {
			t.Errorf("oauth2TokenURL(%v) = %s, want %s", c.data, got, c.want)
		}
	}
}

func TestBaseURLOverride(t *testing.T) {
	c := &client{base: normalizeBaseURL(" https://proxy.example.com/ ")}
	for a, want := range map[api]string{
		apiSheets: "https://proxy.example.com/v4/spreadsheets/x", apiGmail: "https://proxy.example.com/v4/spreadsheets/x",
	} {
		if got := c.url(a, "/v4/spreadsheets/x", nil); got != want {
			t.Errorf("%s url = %s", a.name, got)
		}
	}
	google := &client{}
	for a, want := range map[api]string{
		apiSheets: "https://sheets.googleapis.com", apiGmail: "https://gmail.googleapis.com", apiDrive: "https://www.googleapis.com",
		apiCalendar: "https://www.googleapis.com", apiDocs: "https://docs.googleapis.com",
	} {
		if got := google.url(a, "/p", nil); got != want+"/p" {
			t.Errorf("%s url = %s", a.name, got)
		}
	}
}
