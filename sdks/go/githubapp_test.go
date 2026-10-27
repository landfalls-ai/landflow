package landflow

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func pkcs1PEM(key *rsa.PrivateKey) string {
	return string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))
}

func pkcs8PEM(t *testing.T, key *rsa.PrivateKey) string {
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
}

func verifyJWT(t *testing.T, token string, pub *rsa.PublicKey) map[string]any {
	t.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("not a JWT: %q", token)
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(pub, crypto.SHA256, sum[:], sig); err != nil {
		t.Fatalf("bad signature: %v", err)
	}
	var header, claims map[string]any
	for i, dst := range []*map[string]any{&header, &claims} {
		raw, _ := base64.RawURLEncoding.DecodeString(parts[i])
		if err := json.Unmarshal(raw, dst); err != nil {
			t.Fatal(err)
		}
	}
	if header["alg"] != "RS256" || header["typ"] != "JWT" {
		t.Fatalf("header %v", header)
	}
	return claims
}

func TestGitHubAppJWTClaims(t *testing.T) {
	key := testKey(t)
	now := time.Unix(1_700_000_000, 0)
	for name, pemText := range map[string]string{"pkcs1": pkcs1PEM(key), "pkcs8": pkcs8PEM(t, key)} {
		token, err := GitHubAppJWT(" 12345 ", pemText, now)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		claims := verifyJWT(t, token, &key.PublicKey)
		if claims["iss"] != "12345" || claims["iat"] != float64(1_700_000_000-60) || claims["exp"] != float64(1_700_000_000+540) {
			t.Fatalf("%s: claims %v", name, claims)
		}
	}
}

func TestParseRSAPrivateKeyToleratesMangledPEM(t *testing.T) {
	key := testKey(t)
	original := pkcs1PEM(key)
	variants := map[string]string{
		"literal \\n":    strings.ReplaceAll(original, "\n", `\n`),
		"collapsed":      strings.Join(strings.Fields(original), " "),
		"one line":       strings.ReplaceAll(strings.TrimSpace(original), "\n", ""),
		"crlf":           strings.ReplaceAll(original, "\n", "\r\n"),
		"surrounding ws": "\n  " + original + "  \n",
	}
	for name, text := range variants {
		if name == "one line" {
			// Header and footer glued to the body still parse: the labels are matched, not the line breaks.
			text = strings.Replace(strings.Replace(text, "KEY-----", "KEY----- ", 1), "-----END", " -----END", 1)
		}
		got, err := ParseRSAPrivateKey(text)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if got.N.Cmp(key.N) != 0 || got.D.Cmp(key.D) != 0 {
			t.Fatalf("%s: a different key", name)
		}
	}
}

func TestParseRSAPrivateKeyErrors(t *testing.T) {
	key := testKey(t)
	cases := map[string]string{
		"not pem":    "hello",
		"encrypted":  "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----",
		"ec":         "-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----",
		"bad base64": "-----BEGIN PRIVATE KEY-----\n!!!!\n-----END PRIVATE KEY-----",
		"truncated":  "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----",
	}
	for name, text := range cases {
		if _, err := ParseRSAPrivateKey(text); err == nil {
			t.Fatalf("%s: expected an error", name)
		}
	}
	if _, err := ParseRSAPrivateKey(pkcs1PEM(key)); err != nil {
		t.Fatal(err)
	}
	if _, err := ParseRSAPrivateKey("-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----"); err == nil ||
		!strings.Contains(err.Error(), "encrypted") {
		t.Fatalf("encrypted key error: %v", err)
	}
}

type fakeGitHub struct {
	server  *httptest.Server
	mints   atomic.Int32
	expires func() time.Time
	pub     *rsa.PublicKey
	t       *testing.T
	revoked atomic.Value // token the API now answers 401 to
	denyAll atomic.Bool
}

func newFakeGitHub(t *testing.T, pub *rsa.PublicKey) *fakeGitHub {
	f := &fakeGitHub{t: t, pub: pub, expires: func() time.Time { return time.Now().Add(time.Hour) }}
	f.revoked.Store("")
	mux := http.NewServeMux()
	mux.HandleFunc("POST /app/installations/{id}/access_tokens", func(w http.ResponseWriter, r *http.Request) {
		claims := verifyJWT(t, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), f.pub)
		if claims["iss"] != "42" || r.PathValue("id") != "777" {
			http.Error(w, "bad request", http.StatusForbidden)
			return
		}
		n := f.mints.Add(1)
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]string{"token": "ghs_token" + string(rune('0'+n)), "expires_at": f.expires().UTC().Format(time.RFC3339)})
	})
	mux.HandleFunc("GET /user", func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if f.denyAll.Load() || token == f.revoked.Load().(string) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(token))
	})
	f.server = httptest.NewServer(mux)
	t.Cleanup(f.server.Close)
	return f
}

func TestGitHubAppTokensCacheAndRefresh(t *testing.T) {
	key := testKey(t)
	fake := newFakeGitHub(t, &key.PublicKey)
	clock := time.Now()
	tokens := NewGitHubAppTokens(GitHubAppConfig{
		AppID: "42", PrivateKey: pkcs8PEM(t, key), InstallationID: "777", BaseURL: fake.server.URL + "/",
		Now: func() time.Time { return clock },
	})
	fake.expires = func() time.Time { return clock.Add(time.Hour) }
	ctx := context.Background()

	first, err := tokens.Token(ctx, false)
	if err != nil || first != "ghs_token1" {
		t.Fatalf("first: %q %v", first, err)
	}
	if again, _ := tokens.Token(ctx, false); again != first || fake.mints.Load() != 1 {
		t.Fatalf("not cached: %q, %d mints", again, fake.mints.Load())
	}
	clock = clock.Add(59*time.Minute + 30*time.Second) // inside the 60 s margin of the hour
	if next, _ := tokens.Token(ctx, false); next != "ghs_token2" || fake.mints.Load() != 2 {
		t.Fatalf("not refreshed: %q, %d mints", next, fake.mints.Load())
	}
	if forced, _ := tokens.Token(ctx, true); forced != "ghs_token3" {
		t.Fatalf("fresh: %q", forced)
	}
}

func TestGitHubAppTokensDoMintsAgainAfter401(t *testing.T) {
	key := testKey(t)
	fake := newFakeGitHub(t, &key.PublicKey)
	tokens := NewGitHubAppTokens(GitHubAppConfig{AppID: "42", PrivateKey: pkcs1PEM(key), InstallationID: "777", BaseURL: fake.server.URL})

	get := func() (int, string) {
		req, _ := http.NewRequest(http.MethodGet, fake.server.URL+"/user", nil)
		resp, err := tokens.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(body)
	}
	if status, body := get(); status != 200 || body != "ghs_token1" {
		t.Fatalf("first: %d %q", status, body)
	}
	fake.revoked.Store("ghs_token1")
	if status, body := get(); status != 200 || body != "ghs_token2" || fake.mints.Load() != 2 {
		t.Fatalf("after 401: %d %q, %d mints", status, body, fake.mints.Load())
	}
	// Every token rejected: the 401 is returned after one new mint, not retried forever.
	fake.denyAll.Store(true)
	before := fake.mints.Load()
	if status, _ := get(); status != http.StatusUnauthorized || fake.mints.Load() != before+1 {
		t.Fatalf("persistent 401: %d, %d mints (was %d)", status, fake.mints.Load(), before)
	}
}

func TestGitHubAppTokensErrors(t *testing.T) {
	key := testKey(t)
	if _, err := NewGitHubAppTokens(GitHubAppConfig{AppID: "42", PrivateKey: pkcs1PEM(key)}).Token(context.Background(), false); err == nil ||
		!strings.Contains(err.Error(), "installation id") {
		t.Fatalf("missing installation: %v", err)
	}
	if _, err := NewGitHubAppTokens(GitHubAppConfig{AppID: "42", PrivateKey: "nope", InstallationID: "1"}).Token(context.Background(), false); err == nil {
		t.Fatal("expected a key error")
	}
	rejecting := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusForbidden) }))
	defer rejecting.Close()
	if _, err := NewGitHubAppTokens(GitHubAppConfig{AppID: "42", PrivateKey: pkcs1PEM(key), InstallationID: "1", BaseURL: rejecting.URL}).
		Token(context.Background(), false); err == nil || !strings.Contains(err.Error(), "403") {
		t.Fatalf("rejected: %v", err)
	}
}
