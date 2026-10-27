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
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

// GitHub App authentication: an RS256 JWT signed with the app's private key,
// traded for an installation token. Same behaviour as landflow_sdk.jwt in the
// Python SDK and githubAppJwt in @landflow/sdk.
//
//	jwt, err := landflow.GitHubAppJWT(creds.String("appId"), creds.String("privateKey"), time.Now())
//
//	tokens := landflow.NewGitHubAppTokens(landflow.GitHubAppConfig{AppID: appID, PrivateKey: key, InstallationID: id})
//	token, err := tokens.Token(ctx, false) // cached until a minute before it expires; true mints a new one (after a 401)

const (
	// GitHubAPIURL is the default API base URL (GitHub Enterprise Server uses https://host/api/v3).
	GitHubAPIURL = "https://api.github.com"
	// githubRefreshMargin is how long before expires_at a cached installation token is replaced.
	githubRefreshMargin = 60 * time.Second
)

var pemBlock = regexp.MustCompile(`(?s)-----BEGIN ([A-Z ]+)-----(.*?)-----END ([A-Z ]+)-----`)

// ParseRSAPrivateKey reads a PEM RSA private key (PKCS#1 "RSA PRIVATE KEY" or
// PKCS#8 "PRIVATE KEY"). It tolerates a key pasted into a single-line field
// (literal \n sequences) and one whose line breaks collapsed to spaces. An
// encrypted key is refused.
func ParseRSAPrivateKey(pemText string) (*rsa.PrivateKey, error) {
	text := strings.ReplaceAll(strings.TrimSpace(pemText), `\n`, "\n")
	m := pemBlock.FindStringSubmatch(text)
	if m == nil || m[1] != m[3] {
		return nil, errors.New("the private key is not PEM (expected -----BEGIN RSA PRIVATE KEY----- or -----BEGIN PRIVATE KEY-----)")
	}
	label := m[1]
	if label == "ENCRYPTED PRIVATE KEY" {
		return nil, errors.New("the private key is encrypted; remove the passphrase first (openssl rsa -in key.pem -out plain.pem)")
	}
	if label != "RSA PRIVATE KEY" && label != "PRIVATE KEY" {
		return nil, fmt.Errorf("unsupported key type %q; an RSA private key is required", label)
	}
	// Whitespace (spaces from collapsed newlines included) is not part of the base64 body.
	der, err := base64.StdEncoding.DecodeString(strings.Join(strings.Fields(m[2]), ""))
	if err != nil {
		return nil, errors.New("the private key PEM is not valid base64")
	}
	if label == "RSA PRIVATE KEY" {
		key, err := x509.ParsePKCS1PrivateKey(der)
		if err != nil {
			return nil, errors.New("malformed RSA private key")
		}
		return key, nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		return nil, errors.New("malformed PKCS#8 private key")
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("the private key is not an RSA key")
	}
	return key, nil
}

func b64url(data []byte) string { return base64.RawURLEncoding.EncodeToString(data) }

// RS256Sign returns a compact JWS (header.payload.signature) with alg RS256.
// headers adds to {"alg", "typ"}; alg cannot be overridden.
func RS256Sign(privateKeyPEM string, payload map[string]any, headers map[string]any) (string, error) {
	key, err := ParseRSAPrivateKey(privateKeyPEM)
	if err != nil {
		return "", err
	}
	if key.N.BitLen() < 2048 {
		return "", errors.New("the RSA key is too short for RS256 (use at least 2048 bits)")
	}
	header := map[string]any{"typ": "JWT"}
	for k, v := range headers {
		header[k] = v
	}
	header["alg"] = "RS256"
	h, err := json.Marshal(header)
	if err != nil {
		return "", err
	}
	p, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	input := b64url(h) + "." + b64url(p)
	sum := sha256.Sum256([]byte(input))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		return "", err
	}
	return input + "." + b64url(sig), nil
}

// GitHubAppJWT returns a GitHub App JWT: iss is the app id (a client id works
// too), iat is now-60s (clock drift) and exp is now+540s (GitHub's limit is ten
// minutes).
func GitHubAppJWT(appID, privateKeyPEM string, now time.Time) (string, error) {
	issued := now.Unix()
	return RS256Sign(privateKeyPEM, map[string]any{"iat": issued - 60, "exp": issued + 540, "iss": strings.TrimSpace(appID)}, nil)
}

// GitHubAppConfig is a githubAppApi credential.
type GitHubAppConfig struct {
	AppID          string
	PrivateKey     string
	InstallationID string       // required
	BaseURL        string       // default GitHubAPIURL
	HTTPClient     *http.Client // default http.DefaultClient
	Now            func() time.Time
}

// GitHubAppTokens mints and caches installation tokens for one app installation.
type GitHubAppTokens struct {
	cfg GitHubAppConfig

	mu      sync.Mutex
	token   string
	expires time.Time
}

// NewGitHubAppTokens returns a token source for cfg.
func NewGitHubAppTokens(cfg GitHubAppConfig) *GitHubAppTokens {
	cfg.BaseURL = strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	if cfg.BaseURL == "" {
		cfg.BaseURL = GitHubAPIURL
	}
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = http.DefaultClient
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &GitHubAppTokens{cfg: cfg}
}

// Token returns the cached installation token, or mints one with
// POST /app/installations/{id}/access_tokens. A token is replaced a minute
// before its expires_at. fresh discards the cache first: call it with true
// after the API answered 401 with the cached token.
func (g *GitHubAppTokens) Token(ctx context.Context, fresh bool) (string, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.cfg.Now()
	if fresh {
		g.token = ""
	} else if g.token != "" && g.expires.Add(-githubRefreshMargin).After(now) {
		return g.token, nil
	}
	if strings.TrimSpace(g.cfg.InstallationID) == "" {
		return "", errors.New("GitHub App: an installation id is required")
	}
	jwt, err := GitHubAppJWT(g.cfg.AppID, g.cfg.PrivateKey, now)
	if err != nil {
		return "", fmt.Errorf("GitHub App: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		g.cfg.BaseURL+"/app/installations/"+strings.TrimSpace(g.cfg.InstallationID)+"/access_tokens", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+jwt)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	resp, err := g.cfg.HTTPClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("GitHub App: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return "", fmt.Errorf("GitHub App: minting an installation token failed with HTTP %d", resp.StatusCode)
	}
	var out struct {
		Token     string `json:"token"`
		ExpiresAt string `json:"expires_at"`
	}
	if err := json.Unmarshal(body, &out); err != nil || out.Token == "" {
		return "", errors.New("GitHub App: GitHub returned no installation token")
	}
	expires, err := time.Parse(time.RFC3339, out.ExpiresAt)
	if err != nil {
		expires = now.Add(50 * time.Minute) // unknown: a bit under the usual hour
	}
	g.token, g.expires = out.Token, expires
	return g.token, nil
}

// Do sends req with the installation token and, on a 401 (a revoked or expired
// token), mints a new token and sends it once more. A request with a body must
// set GetBody (http.NewRequest does for common body types).
func (g *GitHubAppTokens) Do(req *http.Request) (*http.Response, error) {
	for attempt := 0; ; attempt++ {
		token, err := g.Token(req.Context(), attempt == 1)
		if err != nil {
			return nil, err
		}
		r := req.Clone(req.Context())
		if attempt == 1 && req.GetBody != nil {
			if r.Body, err = req.GetBody(); err != nil {
				return nil, err
			}
		}
		r.Header.Set("Authorization", "Bearer "+token)
		resp, err := g.cfg.HTTPClient.Do(r)
		if err != nil || resp.StatusCode != http.StatusUnauthorized || attempt == 1 {
			return resp, err
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
	}
}
