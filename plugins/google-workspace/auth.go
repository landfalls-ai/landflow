package main

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	landflow "github.com/landflow/landflow/sdks/go"
)

// Authentication: the two credential types, the service-account JWT (RS256)
// and refresh-token grants, and a per-credential access-token cache. The
// OAuth2 type extends the host's generic OAuth2 type: after Connect, the host
// runs the consent flow, keeps the refresh token and sends a fresh
// accessToken with every call; a refresh token entered by hand still works.

const (
	credServiceAccount = "googleApi"
	credOAuth2         = "googleOAuth2Api"

	defaultTokenURL = "https://oauth2.googleapis.com/token"
	jwtBearerGrant  = "urn:ietf:params:oauth:grant-type:jwt-bearer"

	// The consent flow the host runs for Connect (see oauth2Credential).
	googleAuthURL     = "https://accounts.google.com/o/oauth2/v2/auth"
	googleUserInfoURL = "https://openidconnect.googleapis.com/v1/userinfo"
	// offline + consent: Google returns a refresh token on every Connect.
	googleAuthQuery = "access_type=offline&prompt=consent"

	// Auth kinds: the "auth" metric attribute and the google.auth span attribute.
	authServiceAccount = "service_account"
	authOAuth2         = "oauth2"

	jwtLifetime = time.Hour
	// expiryMargin: a cached token is replaced this long before it expires.
	expiryMargin = 60 * time.Second

	tracerName = "github.com/landflow/landflow/plugins/google-workspace"
)

// googleScopes are requested for service-account tokens. With domain-wide
// delegation the Workspace admin authorizes exactly these for the client ID.
var googleScopes = []string{
	"https://www.googleapis.com/auth/spreadsheets",
	"https://www.googleapis.com/auth/drive",
	"https://www.googleapis.com/auth/gmail.modify",
	"https://www.googleapis.com/auth/calendar",
	"https://www.googleapis.com/auth/documents",
}

// now is replaceable in tests (JWT iat/exp and the token cache).
var now = time.Now

var baseURLProperty = landflow.PropertyDescriptor{
	Name: "baseUrl", DisplayName: "API Base URL (advanced)", Type: landflow.PropString, Default: "",
	Placeholder: "https://proxy.example.com",
	Description: "Leave empty for Google. When set, it replaces the host of every Google API and keeps the paths " +
		"(/v4/spreadsheets…, /gmail/v1/…, /drive/v3/…, /calendar/v3/…, /v1/documents…), e.g. for a proxy or a test double.",
}

var tokenURLProperty = landflow.PropertyDescriptor{
	Name: "tokenUrl", DisplayName: "Token URL", Type: landflow.PropString, Default: defaultTokenURL,
	Description: "OAuth 2.0 token endpoint",
}

var serviceAccountCredential = landflow.CredentialType{
	Name:        credServiceAccount,
	DisplayName: "Google Service Account",
	Description: "A service account key. Share spreadsheets, files and calendars with the service account's email; " +
		"Gmail needs domain-wide delegation (Impersonate a User).",
	Icon:             "file:icons/google-workspace.svg",
	DocumentationURL: "https://developers.google.com/identity/protocols/oauth2/service-account",
	Properties: []landflow.PropertyDescriptor{
		{
			Name: "email", DisplayName: "Service Account Email", Type: landflow.PropString, Required: true,
			Placeholder: "robot@my-project.iam.gserviceaccount.com",
			Description: "client_email from the JSON key file",
		},
		{
			Name: "privateKey", DisplayName: "Private Key", Type: landflow.PropString, Required: true,
			TypeOptions: &landflow.TypeOptions{Password: true},
			Placeholder: "-----BEGIN PRIVATE KEY-----…",
			Description: "private_key from the JSON key file. Escaped \\n sequences and a pasted line without newlines both work, " +
				"and so does the whole JSON key file.",
		},
		{
			Name: "delegatedEmail", DisplayName: "Impersonate a User", Type: landflow.PropString, Default: "",
			Placeholder: "someone@your-domain.com",
			Description: "Optional. Act as this Workspace user through domain-wide delegation; required for Gmail.",
		},
		tokenURLProperty,
		baseURLProperty,
	},
	Test: testServiceAccount,
}

// oauth2Credential extends the host's generic OAuth2 type ("oAuth2Api"): the
// host merges these properties over the generic ones, shows Connect, and
// hands nodes accessToken/expiresAt. Hidden fields pin the flow to Google.
var oauth2Credential = landflow.CredentialType{
	Name:        credOAuth2,
	DisplayName: "Google OAuth2",
	Description: "Sign in with Google: create an OAuth client (Web application) in Google Cloud, add the redirect URL shown below, " +
		"then Connect. A refresh token obtained elsewhere (OAuth Playground, gcloud) works too.",
	Icon:             "file:icons/google-workspace.svg",
	DocumentationURL: "https://developers.google.com/identity/protocols/oauth2/web-server",
	Extends:          []string{"oAuth2Api"},
	Properties: []landflow.PropertyDescriptor{
		{Name: "grantType", DisplayName: "Grant Type", Type: landflow.PropHidden, Default: "pkce"},
		{Name: "authUrl", DisplayName: "Authorization URL", Type: landflow.PropHidden, Default: googleAuthURL},
		{Name: "accessTokenUrl", DisplayName: "Access Token URL", Type: landflow.PropString, Default: defaultTokenURL,
			Description: "OAuth 2.0 token endpoint"},
		{Name: "clientId", DisplayName: "Client ID", Type: landflow.PropString, Required: true,
			Placeholder: "1234-abc.apps.googleusercontent.com"},
		{Name: "clientSecret", DisplayName: "Client Secret", Type: landflow.PropString, Required: true,
			TypeOptions: &landflow.TypeOptions{Password: true}},
		{Name: "scope", DisplayName: "Scope", Type: landflow.PropString, Default: strings.Join(append(slices.Clone(googleScopes), "openid", "email"), " "),
			Description: "Space-separated scopes asked for at Connect. Trim it to the APIs your workflows use; openid and email show who connected."},
		{Name: "authQueryParameters", DisplayName: "Auth URI Query Parameters", Type: landflow.PropHidden, Default: googleAuthQuery},
		{Name: "authentication", DisplayName: "Authentication", Type: landflow.PropHidden, Default: "body"},
		{Name: "userInfoUrl", DisplayName: "User Info URL", Type: landflow.PropHidden, Default: googleUserInfoURL},
		{Name: "refreshToken", DisplayName: "Refresh Token (without Connect)", Type: landflow.PropString, Default: "",
			TypeOptions: &landflow.TypeOptions{Password: true},
			Description: "Optional: only when not using Connect. A refresh token for this client with the scopes you need (see the plugin README)."},
		baseURLProperty,
	},
	Test: testOAuth2,
}

// tokenSource hands out access tokens for one credential.
type tokenSource struct {
	kind     string // authServiceAccount | authOAuth2
	tokenURL string
	cacheKey string

	// service account
	email   string
	subject string // delegatedEmail
	key     *rsa.PrivateKey

	// OAuth2
	clientID, clientSecret, refreshToken string
	// hostToken is the access token the host sent (a Connected credential);
	// hostRejected is set once Google answered 401 to it.
	hostToken    string
	hostRejected atomic.Bool
}

// tokenResponse is the token endpoint's JSON answer (success or error).
type tokenResponse struct {
	AccessToken      string          `json:"access_token"`
	ExpiresIn        int             `json:"expires_in"`
	TokenType        string          `json:"token_type"`
	Scope            string          `json:"scope"`
	Error            json.RawMessage `json:"error"`
	ErrorDescription string          `json:"error_description"`
}

// errorCode returns the OAuth error code ("invalid_grant"), also when Google
// wraps it in an object.
func (t tokenResponse) errorCode() (code, message string) {
	var s string
	if json.Unmarshal(t.Error, &s) == nil {
		return s, t.ErrorDescription
	}
	var obj struct {
		Message string `json:"message"`
		Status  string `json:"status"`
	}
	if json.Unmarshal(t.Error, &obj) == nil {
		return obj.Status, obj.Message
	}
	return "", t.ErrorDescription
}

func newTokenSource(credType string, data landflow.CredentialData) (*tokenSource, error) {
	ts := &tokenSource{tokenURL: strings.TrimSpace(data.StringOr("tokenUrl", defaultTokenURL))}
	switch credType {
	case credServiceAccount:
		raw := data.String("privateKey")
		ts.kind = authServiceAccount
		ts.email = strings.TrimSpace(data.String("email"))
		if ts.email == "" {
			ts.email = keyFileField(raw, "client_email")
		}
		if ts.email == "" {
			return nil, errors.New("the service account email is required")
		}
		key, err := parsePrivateKey(raw)
		if err != nil {
			return nil, err
		}
		ts.key = key
		ts.subject = strings.TrimSpace(data.String("delegatedEmail"))
		ts.cacheKey = cacheKey(ts.kind, ts.tokenURL, ts.email, ts.subject, raw)
	case credOAuth2:
		ts.kind = authOAuth2
		ts.tokenURL = oauth2TokenURL(data)
		ts.clientID = strings.TrimSpace(data.String("clientId"))
		ts.clientSecret = strings.TrimSpace(data.String("clientSecret"))
		ts.refreshToken = strings.TrimSpace(data.String("refreshToken"))
		ts.hostToken = strings.TrimSpace(data.String("accessToken"))
		if ts.hostToken == "" && (ts.clientID == "" || ts.clientSecret == "" || ts.refreshToken == "") {
			return nil, errors.New("the OAuth2 credential is not connected: Connect it in Credentials, or enter a client ID, a client secret and a refresh token")
		}
		ts.cacheKey = cacheKey(ts.kind, ts.tokenURL, ts.clientID, ts.clientSecret, ts.refreshToken)
	default:
		return nil, fmt.Errorf("unknown credential type %q", credType)
	}
	if u, err := url.Parse(ts.tokenURL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, errors.New("the token URL must be an http(s) URL")
	}
	return ts, nil
}

// oauth2TokenURL is the OAuth2 token endpoint: accessTokenUrl (the field
// shared with the host's OAuth2 type) when changed from Google's, else the
// tokenUrl of credentials saved before it existed, else Google's.
func oauth2TokenURL(data landflow.CredentialData) string {
	if u := strings.TrimSpace(data.String("accessTokenUrl")); u != "" && u != defaultTokenURL {
		return u
	}
	return strings.TrimSpace(data.StringOr("tokenUrl", defaultTokenURL))
}

// renewable reports whether a 401 can be answered with a new token here: not
// for a host token without a refresh token (the host renews it and runs the
// node again when the error mentions 401).
func (ts *tokenSource) renewable() bool { return ts.hostToken == "" || ts.refreshToken != "" }

// cacheKey identifies a credential without keeping its secrets as map keys.
func cacheKey(parts ...string) string {
	h := sha256.New()
	for _, p := range parts {
		h.Write([]byte(p))
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))
}

// tokenEntry is one cached access token. Its mutex also makes concurrent
// requests for the same credential wait for a single exchange.
type tokenEntry struct {
	mu     sync.Mutex
	token  string
	expiry time.Time
}

// tokenCache maps cacheKey → *tokenEntry for the life of the process.
var tokenCache sync.Map

func (ts *tokenSource) entry() *tokenEntry {
	e, _ := tokenCache.LoadOrStore(ts.cacheKey, &tokenEntry{})
	return e.(*tokenEntry)
}

// Token returns a valid access token, from the cache unless force is set or
// the cached one expires within expiryMargin. resp is the token endpoint's
// answer when an exchange happened (nil on a cache hit). The work happens in
// a "google.oauth.token" span with landflow.cache_hit; m (may be nil) counts
// exchanges in landflow.google.token_refreshes.
func (ts *tokenSource) Token(ctx context.Context, m *landflow.Metrics, force bool) (token string, resp *tokenResponse, err error) {
	// CredentialType.Test gets a plain context, so the span comes from the
	// tracer provider of the current (SDK) span rather than from ctx.Span.
	tracer := trace.SpanFromContext(ctx).TracerProvider().Tracer(tracerName)
	ctx, span := tracer.Start(ctx, "google.oauth.token", trace.WithAttributes(attribute.String("google.auth", ts.kind)))
	defer span.End()

	// The host keeps a Connected credential's token fresh: use it as is.
	if ts.hostToken != "" && !ts.hostRejected.Load() {
		span.SetAttributes(attribute.Bool("landflow.cache_hit", true), attribute.Bool("google.host_token", true))
		return ts.hostToken, nil, nil
	}

	e := ts.entry()
	e.mu.Lock()
	defer e.mu.Unlock()
	if !force && e.token != "" && now().Before(e.expiry.Add(-expiryMargin)) {
		span.SetAttributes(attribute.Bool("landflow.cache_hit", true))
		return e.token, nil, nil
	}
	span.SetAttributes(attribute.Bool("landflow.cache_hit", false))

	resp, err = ts.exchange(ctx)
	outcome := "success"
	if err != nil {
		outcome = "error"
	}
	m.Counter("landflow.google.token_refreshes", landflow.WithDescription("Access-token exchanges with Google's token endpoint")).
		Add(1, landflow.Attrs{"auth": ts.kind, "outcome": outcome})
	if err != nil {
		msg := landflow.RedactString(ctx, err.Error())
		span.SetStatus(codes.Error, msg)
		span.AddEvent("exception", trace.WithAttributes(
			attribute.String("exception.type", "google.oauth.token_error"),
			attribute.String("exception.message", msg),
		))
		return "", nil, err
	}
	ttl := time.Duration(resp.ExpiresIn) * time.Second
	if ttl <= 0 {
		ttl = jwtLifetime
	}
	e.token, e.expiry = resp.AccessToken, now().Add(ttl)
	return e.token, resp, nil
}

// Invalidate drops token from the cache (after Google answered 401 to it).
// A rejected host token is not used again by this token source.
func (ts *tokenSource) Invalidate(token string) {
	if ts.hostToken != "" && token == ts.hostToken {
		ts.hostRejected.Store(true)
		return
	}
	e := ts.entry()
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.token == token {
		e.token, e.expiry = "", time.Time{}
	}
}

// exchange calls the token endpoint. The request body (assertion, client
// secret, refresh token) is never logged, recorded or echoed in errors.
func (ts *tokenSource) exchange(ctx context.Context) (*tokenResponse, error) {
	form := url.Values{}
	switch ts.kind {
	case authServiceAccount:
		assertion, err := ts.assertion()
		if err != nil {
			return nil, err
		}
		form.Set("grant_type", jwtBearerGrant)
		form.Set("assertion", assertion)
	case authOAuth2:
		form.Set("grant_type", "refresh_token")
		form.Set("client_id", ts.clientID)
		form.Set("client_secret", ts.clientSecret)
		form.Set("refresh_token", ts.refreshToken)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ts.tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, fmt.Errorf("invalid token URL: %v", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := landflow.HTTPClient(ctx).Do(req)
	if err != nil {
		return nil, fmt.Errorf("cannot reach the token endpoint: %v", transportError(err))
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var tr tokenResponse
	_ = json.Unmarshal(body, &tr)
	if resp.StatusCode != http.StatusOK || tr.AccessToken == "" {
		return nil, ts.tokenError(resp.StatusCode, tr)
	}
	return &tr, nil
}

// assertion builds the signed JWT of the service-account flow.
func (ts *tokenSource) assertion() (string, error) {
	iat := now().Unix()
	claims := map[string]any{
		"iss":   ts.email,
		"scope": strings.Join(googleScopes, " "),
		"aud":   ts.tokenURL,
		"iat":   iat,
		"exp":   iat + int64(jwtLifetime/time.Second),
	}
	if ts.subject != "" {
		claims["sub"] = ts.subject
	}
	return signJWT(ts.key, claims)
}

// signJWT returns header.payload.signature with an RS256 (RSASSA-PKCS1-v1_5,
// SHA-256) signature.
func signJWT(key *rsa.PrivateKey, claims map[string]any) (string, error) {
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	input := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`)) + "." +
		base64.RawURLEncoding.EncodeToString(payload)
	sum := sha256.Sum256([]byte(input))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		return "", fmt.Errorf("sign the service account JWT: %v", err)
	}
	return input + "." + base64.RawURLEncoding.EncodeToString(sig), nil
}

// tokenError explains a failed exchange with Google's error code and
// description, plus a hint for the common causes.
func (ts *tokenSource) tokenError(status int, tr tokenResponse) error {
	code, desc := tr.errorCode()
	what := "service account"
	if ts.kind == authOAuth2 {
		what = "OAuth2"
	}
	msg := fmt.Sprintf("Google rejected the %s credential (HTTP %d", what, status)
	if code != "" {
		msg += " " + code
	}
	msg += ")"
	if desc != "" {
		msg += ": " + desc
	}
	if hint := tokenHint(ts.kind, code, desc, ts.subject != ""); hint != "" {
		msg = strings.TrimSuffix(msg, ".") + ". " + hint
	}
	return errors.New(msg)
}

func tokenHint(kind, code, desc string, delegated bool) string {
	d := strings.ToLower(desc)
	switch {
	case kind == authServiceAccount && strings.Contains(d, "signature"):
		return "Check that the private key belongs to this service account and has not been deleted."
	case kind == authServiceAccount && (strings.Contains(d, "email") || strings.Contains(d, "not found")):
		return "Check the service account email."
	case kind == authServiceAccount && code == "unauthorized_client" && delegated:
		return "Authorize the service account's client ID for the plugin's scopes under domain-wide delegation in the Admin console."
	case kind == authServiceAccount && code == "invalid_grant" && delegated:
		return "Check the impersonated user's email and the domain-wide delegation settings."
	case kind == authOAuth2 && code == "invalid_grant":
		return "The refresh token is invalid, expired or revoked; create a new one."
	case kind == authOAuth2 && (code == "invalid_client" || code == "unauthorized_client"):
		return "Check the client ID and client secret; the refresh token must come from the same OAuth client."
	}
	return ""
}

// parsePrivateKey reads an RSA key in PEM form (PKCS#8 or PKCS#1). It is
// lenient about how the key was pasted: escaped \n sequences, a single line
// without newlines (password inputs drop them), or the whole JSON key file.
func parsePrivateKey(raw string) (*rsa.PrivateKey, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return nil, errors.New("the private key is required")
	}
	if strings.HasPrefix(s, "{") {
		if k := keyFileField(s, "private_key"); k != "" {
			s = k
		}
	}
	s = strings.ReplaceAll(s, `\n`, "\n")
	const begin, dashes = "-----BEGIN ", "-----"
	start := strings.Index(s, begin)
	if start < 0 {
		return nil, errors.New("the private key is not PEM-encoded: it must start with -----BEGIN PRIVATE KEY-----")
	}
	rest := s[start+len(begin):]
	labelEnd := strings.Index(rest, dashes)
	if labelEnd < 0 {
		return nil, errors.New("the private key's BEGIN line is incomplete")
	}
	label := rest[:labelEnd]
	rest = rest[labelEnd+len(dashes):]
	end := strings.Index(rest, "-----END ")
	if end < 0 {
		return nil, errors.New("the private key has no -----END PRIVATE KEY----- line")
	}
	if label == "ENCRYPTED PRIVATE KEY" {
		return nil, errors.New("encrypted private keys are not supported; use the unencrypted key from the JSON key file")
	}
	der, err := base64.StdEncoding.DecodeString(strings.Join(strings.Fields(rest[:end]), ""))
	if err != nil {
		return nil, errors.New("the private key is not valid PEM: its body is not base64")
	}
	var key any
	if label == "RSA PRIVATE KEY" {
		key, err = x509.ParsePKCS1PrivateKey(der)
	} else if key, err = x509.ParsePKCS8PrivateKey(der); err != nil {
		if k, err1 := x509.ParsePKCS1PrivateKey(der); err1 == nil {
			key, err = k, nil
		}
	}
	if err != nil {
		return nil, fmt.Errorf("the private key could not be parsed: %v", err)
	}
	rsaKey, ok := key.(*rsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("the private key is a %T; Google service account keys are RSA", key)
	}
	return rsaKey, nil
}

// keyFileField reads a field from a pasted JSON key file ("" otherwise).
func keyFileField(raw, field string) string {
	raw = strings.TrimSpace(raw)
	if !strings.HasPrefix(raw, "{") {
		return ""
	}
	var file map[string]any
	if json.Unmarshal([]byte(raw), &file) != nil {
		return ""
	}
	s, _ := file[field].(string)
	return strings.TrimSpace(s)
}

// grantedScopes counts the scopes of a token response, falling back to the
// requested ones (service-account responses usually omit scope).
func grantedScopes(resp *tokenResponse) int {
	if resp != nil {
		if n := len(strings.Fields(resp.Scope)); n > 0 {
			return n
		}
	}
	return len(googleScopes)
}

// testServiceAccount performs a real token exchange (bypassing the cache).
func testServiceAccount(ctx context.Context, data landflow.CredentialData) (bool, string) {
	ts, err := newTokenSource(credServiceAccount, data)
	if err != nil {
		return false, "Invalid service account credential: " + err.Error()
	}
	_, resp, err := ts.Token(ctx, nil, true)
	if err != nil {
		return false, err.Error()
	}
	msg := fmt.Sprintf("Token issued for %s with %d scopes", ts.email, grantedScopes(resp))
	if ts.subject != "" {
		msg += ", impersonating " + ts.subject
	}
	return true, msg
}

// testOAuth2 refreshes the token (or takes the host's, for a Connected
// credential), then asks userinfo who it belongs to. The userinfo call needs
// the openid/email scopes, so its failure is not fatal, except a 401 to the
// host's token.
func testOAuth2(ctx context.Context, data landflow.CredentialData) (bool, string) {
	ts, err := newTokenSource(credOAuth2, data)
	if err != nil {
		return false, "Invalid OAuth2 credential: " + err.Error()
	}
	_, resp, err := ts.Token(ctx, nil, true)
	if err != nil {
		return false, err.Error()
	}
	c := &client{ts: ts, base: normalizeBaseURL(data.String("baseUrl"))}
	var info struct {
		Email string `json:"email"`
	}
	err = c.do(ctx, apiUserinfo, http.MethodGet, "/oauth2/v3/userinfo", nil, nil, &info)
	if resp == nil && ts.hostToken != "" && !ts.hostRejected.Load() {
		var ae *apiError
		switch {
		case err == nil && info.Email != "":
			return true, "Connected as " + info.Email
		case errors.As(err, &ae) && ae.status == http.StatusUnauthorized:
			return false, "Google rejected the access token (HTTP 401); reconnect the credential"
		}
		return true, "Access token works"
	}
	scopes := grantedScopes(resp)
	if err == nil && info.Email != "" {
		return true, fmt.Sprintf("Authenticated as %s (%d scopes granted)", info.Email, scopes)
	}
	return true, fmt.Sprintf("Refresh token works (%d scopes granted)", scopes)
}
