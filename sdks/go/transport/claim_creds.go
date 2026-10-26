package transport

// Credentials for the S3 claim store, standard library only. The chain, in order:
//
//  1. static keys: LANDFLOW_CLAIM_ACCESS_KEY_ID / LANDFLOW_CLAIM_SECRET_ACCESS_KEY, then AWS_ACCESS_KEY_ID /
//     AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN;
//  2. web identity (EKS IRSA): AWS_WEB_IDENTITY_TOKEN_FILE + AWS_ROLE_ARN (+ AWS_ROLE_SESSION_NAME), exchanged at STS
//     AssumeRoleWithWebIdentity (an unsigned form POST). The token file is re-read on every refresh, it rotates. The STS
//     endpoint is AWS_ENDPOINT_URL_STS, else AWS_ENDPOINT_URL, else the regional https://sts.<region>.amazonaws.com, and
//     that last one only when the store URL says aws=true (nothing talks to real AWS unless the operator says so);
//  3. container credentials (EKS Pod Identity, ECS): AWS_CONTAINER_CREDENTIALS_FULL_URI, or
//     AWS_CONTAINER_CREDENTIALS_RELATIVE_URI against http://169.254.170.2, with the Authorization header from
//     AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE (re-read each time) or AWS_CONTAINER_AUTHORIZATION_TOKEN. A FULL_URI over plain
//     http must point at loopback, 169.254.170.2, 169.254.170.23 or fd00:ec2::23 (as the AWS SDKs require); https is
//     allowed anywhere.
//
// Deliberately NOT supported: the shared credentials/config files (~/.aws) and EC2 IMDS. A developer laptop has real
// ~/.aws credentials that must never be picked up by a dev run; IMDS probes time out off EC2; an operator who needs either
// can export the keys. Temporary credentials are cached and refreshed 5 minutes before Expiration, under a mutex.

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// claimCredentialRefreshMargin: temporary credentials are renewed this long before they expire.
const claimCredentialRefreshMargin = 5 * time.Minute

// claimContainerRelativeBase resolves AWS_CONTAINER_CREDENTIALS_RELATIVE_URI (a variable so tests can point it at a fake).
var claimContainerRelativeBase = "http://169.254.170.2"

// ClaimCredentials are one set of S3 credentials. Expires is zero for static keys.
type ClaimCredentials struct {
	AccessKeyID     string
	SecretAccessKey string
	SessionToken    string
	Expires         time.Time
}

// ClaimCredentialProvider supplies credentials for the S3 claim store. Implementations may be called concurrently.
type ClaimCredentialProvider interface {
	// Source names where the credentials come from ("static keys", "web identity", "container credentials"), no secrets.
	Source() string
	Retrieve(ctx context.Context) (ClaimCredentials, error)
}

type staticClaimCredentials struct{ creds ClaimCredentials }

func (s staticClaimCredentials) Source() string { return "static keys" }
func (s staticClaimCredentials) Retrieve(context.Context) (ClaimCredentials, error) {
	return s.creds, nil
}

// cachedClaimCredentials caches a source's temporary credentials and refreshes them before Expires; safe for concurrent use.
type cachedClaimCredentials struct {
	inner ClaimCredentialProvider
	now   func() time.Time
	mu    sync.Mutex
	creds ClaimCredentials
	have  bool
}

func (c *cachedClaimCredentials) Source() string { return c.inner.Source() }

func (c *cachedClaimCredentials) Retrieve(ctx context.Context) (ClaimCredentials, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	if c.have && now.Add(claimCredentialRefreshMargin).Before(c.creds.Expires) {
		return c.creds, nil
	}
	fresh, err := c.inner.Retrieve(ctx)
	if err != nil {
		if c.have && now.Before(c.creds.Expires) {
			return c.creds, nil // still valid: keep going on the old set, the next call tries again
		}
		return ClaimCredentials{}, err
	}
	c.creds, c.have = fresh, true
	return fresh, nil
}

func readClaimBody(res *http.Response) []byte {
	b, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	return b
}

// webIdentityClaimCredentials is STS AssumeRoleWithWebIdentity.
type webIdentityClaimCredentials struct {
	tokenFile, roleARN, sessionName, endpoint string
	client                                    *http.Client
}

func (w *webIdentityClaimCredentials) Source() string { return "web identity" }

func (w *webIdentityClaimCredentials) Retrieve(ctx context.Context) (ClaimCredentials, error) {
	token, err := os.ReadFile(w.tokenFile)
	if err != nil {
		return ClaimCredentials{}, fmt.Errorf("web identity: read AWS_WEB_IDENTITY_TOKEN_FILE: %w", err)
	}
	form := url.Values{
		"Action":           {"AssumeRoleWithWebIdentity"},
		"Version":          {"2011-06-15"},
		"RoleArn":          {w.roleARN},
		"RoleSessionName":  {w.sessionName},
		"WebIdentityToken": {strings.TrimSpace(string(token))},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, w.endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return ClaimCredentials{}, fmt.Errorf("web identity: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/xml")
	res, err := w.client.Do(req)
	if err != nil {
		return ClaimCredentials{}, fmt.Errorf("web identity: STS %s: %w", w.endpoint, err)
	}
	defer res.Body.Close()
	body := readClaimBody(res)
	if res.StatusCode/100 != 2 {
		msg := strings.TrimSpace(string(body))
		if len(msg) > 512 {
			msg = msg[:512]
		}
		return ClaimCredentials{}, fmt.Errorf("web identity: STS %s: %s: %s", w.endpoint, res.Status, msg)
	}
	var doc struct {
		Credentials struct {
			AccessKeyID     string `xml:"AccessKeyId"`
			SecretAccessKey string `xml:"SecretAccessKey"`
			SessionToken    string `xml:"SessionToken"`
			Expiration      string `xml:"Expiration"`
		} `xml:"AssumeRoleWithWebIdentityResult>Credentials"`
	}
	if err := xml.Unmarshal(body, &doc); err != nil {
		return ClaimCredentials{}, fmt.Errorf("web identity: STS answered something that is not XML: %w", err)
	}
	c := doc.Credentials
	return buildClaimCredentials("web identity", c.AccessKeyID, c.SecretAccessKey, c.SessionToken, c.Expiration)
}

func buildClaimCredentials(source, id, secret, token, expiration string) (ClaimCredentials, error) {
	if id == "" || secret == "" {
		return ClaimCredentials{}, fmt.Errorf("%s: the response carries no access key", source)
	}
	exp, err := time.Parse(time.RFC3339, expiration)
	if err != nil {
		return ClaimCredentials{}, fmt.Errorf("%s: the response has no valid Expiration (%q)", source, expiration)
	}
	return ClaimCredentials{AccessKeyID: id, SecretAccessKey: secret, SessionToken: token, Expires: exp}, nil
}

// containerClaimCredentials is the ECS / EKS Pod Identity credentials endpoint.
type containerClaimCredentials struct {
	uri, tokenFile, token string
	client                *http.Client
}

func (c *containerClaimCredentials) Source() string { return "container credentials" }

func (c *containerClaimCredentials) Retrieve(ctx context.Context) (ClaimCredentials, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.uri, nil)
	if err != nil {
		return ClaimCredentials{}, fmt.Errorf("container credentials: %w", err)
	}
	auth := c.token
	if c.tokenFile != "" {
		b, err := os.ReadFile(c.tokenFile)
		if err != nil {
			return ClaimCredentials{}, fmt.Errorf("container credentials: read AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: %w", err)
		}
		auth = strings.TrimSpace(string(b))
	}
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	req.Header.Set("Accept", "application/json")
	res, err := c.client.Do(req)
	if err != nil {
		return ClaimCredentials{}, fmt.Errorf("container credentials: %s: %w", c.uri, err)
	}
	defer res.Body.Close()
	body := readClaimBody(res)
	if res.StatusCode/100 != 2 {
		msg := strings.TrimSpace(string(body))
		if len(msg) > 512 {
			msg = msg[:512]
		}
		return ClaimCredentials{}, fmt.Errorf("container credentials: %s: %s: %s", c.uri, res.Status, msg)
	}
	var doc struct{ AccessKeyId, SecretAccessKey, Token, Expiration string }
	if err := json.Unmarshal(body, &doc); err != nil {
		return ClaimCredentials{}, fmt.Errorf("container credentials: the response is not JSON: %w", err)
	}
	return buildClaimCredentials("container credentials", doc.AccessKeyId, doc.SecretAccessKey, doc.Token, doc.Expiration)
}

// claimContainerHostAllowed: the hosts a plain-http AWS_CONTAINER_CREDENTIALS_FULL_URI may name.
func claimContainerHostAllowed(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	return ip.IsLoopback() || ip.Equal(net.ParseIP("169.254.170.2")) || ip.Equal(net.ParseIP("169.254.170.23")) || ip.Equal(net.ParseIP("fd00:ec2::23"))
}

const claimCredentialSources = "LANDFLOW_CLAIM_ACCESS_KEY_ID + LANDFLOW_CLAIM_SECRET_ACCESS_KEY, " +
	"AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (+ AWS_SESSION_TOKEN), " +
	"AWS_WEB_IDENTITY_TOKEN_FILE + AWS_ROLE_ARN (EKS IRSA), " +
	"AWS_CONTAINER_CREDENTIALS_FULL_URI or AWS_CONTAINER_CREDENTIALS_RELATIVE_URI (EKS Pod Identity, ECS)"

// ResolveClaimCredentials walks the chain above. region and allowAWS come from the store URL; getenv nil = os.Getenv; client nil
// = a client with a 15 s timeout. It does no network I/O: the temporary sources fetch on first use.
func ResolveClaimCredentials(getenv func(string) string, region string, allowAWS bool, client *http.Client, now func() time.Time) (ClaimCredentialProvider, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	if now == nil {
		now = time.Now
	}
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	first := func(names ...string) string {
		for _, n := range names {
			if v := getenv(n); v != "" {
				return v
			}
		}
		return ""
	}
	if id, secret := first("LANDFLOW_CLAIM_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"), first("LANDFLOW_CLAIM_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"); id != "" && secret != "" {
		return staticClaimCredentials{ClaimCredentials{AccessKeyID: id, SecretAccessKey: secret, SessionToken: getenv("AWS_SESSION_TOKEN")}}, nil
	}
	if tokenFile, role := getenv("AWS_WEB_IDENTITY_TOKEN_FILE"), getenv("AWS_ROLE_ARN"); tokenFile != "" && role != "" {
		endpoint := first("AWS_ENDPOINT_URL_STS", "AWS_ENDPOINT_URL")
		if endpoint == "" {
			if !allowAWS {
				return nil, errors.New("claim store: web identity credentials (AWS_WEB_IDENTITY_TOKEN_FILE, AWS_ROLE_ARN) need an STS endpoint: " +
					"set AWS_ENDPOINT_URL_STS (or AWS_ENDPOINT_URL), or add ?aws=true to LANDFLOW_CLAIM_STORE to use the real AWS STS")
			}
			endpoint = "https://sts." + region + ".amazonaws.com"
		}
		name := getenv("AWS_ROLE_SESSION_NAME")
		if name == "" {
			name = "landflow-claim"
		}
		return &cachedClaimCredentials{inner: &webIdentityClaimCredentials{tokenFile: tokenFile, roleARN: role, sessionName: name, endpoint: endpoint, client: client}, now: now}, nil
	}
	full, rel := getenv("AWS_CONTAINER_CREDENTIALS_FULL_URI"), getenv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI")
	if full != "" || rel != "" {
		uri := full
		if uri == "" {
			if !strings.HasPrefix(rel, "/") {
				return nil, errors.New("claim store: AWS_CONTAINER_CREDENTIALS_RELATIVE_URI must start with /")
			}
			uri = claimContainerRelativeBase + rel
		}
		u, err := url.Parse(uri)
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
			return nil, errors.New("claim store: AWS_CONTAINER_CREDENTIALS_FULL_URI is not an http(s) URL")
		}
		if u.Scheme == "http" && full != "" && !claimContainerHostAllowed(u.Hostname()) {
			return nil, fmt.Errorf("claim store: AWS_CONTAINER_CREDENTIALS_FULL_URI over plain http must name loopback, 169.254.170.2, 169.254.170.23 or fd00:ec2::23, not %q (use https)", u.Hostname())
		}
		return &cachedClaimCredentials{inner: &containerClaimCredentials{uri: uri, tokenFile: getenv("AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE"), token: getenv("AWS_CONTAINER_AUTHORIZATION_TOKEN"), client: client}, now: now}, nil
	}
	return nil, errors.New("claim store: no credentials found; tried, in order: " + claimCredentialSources +
		". The shared credentials/config files (~/.aws) and EC2 IMDS are deliberately not read; export the keys if you need them")
}
