package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	landflow "github.com/landflow/landflow/sdks/go"
)

// service is one threat-intel API: its default host and how it is named in errors.
type service struct {
	id    string // "virustotal": the id IOC Enrich reports
	title string // "VirusTotal": shown in error messages
	host  string // default API base URL ("" = the credential must give one)
}

var (
	svcVirusTotal = service{"virustotal", "VirusTotal", "https://www.virustotal.com"}
	svcAbuseIPDB  = service{"abuseipdb", "AbuseIPDB", "https://api.abuseipdb.com"}
	svcGreyNoise  = service{"greynoise", "GreyNoise", "https://api.greynoise.io"}
	svcURLScan    = service{"urlscan", "urlscan.io", "https://urlscan.io"}
	svcShodan     = service{"shodan", "Shodan", "https://api.shodan.io"}
	svcOTX        = service{"otx", "AlienVault OTX", "https://otx.alienvault.com"}
	svcMISP       = service{"misp", "MISP", ""}
)

const (
	requestTimeout = 30 * time.Second
	// maxRetryWait caps how long a 429 Retry-After is honoured: a longer wait fails the call instead of holding the
	// workflow run, and the error says when to retry.
	maxRetryWait = 30 * time.Second
	// defaultRetryWait applies when a 429 carries no usable Retry-After.
	defaultRetryWait = time.Second
	maxResponseBytes = 8 << 20
)

// sleep waits d or until ctx ends. Tests replace it.
var sleep = func(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// apiClient calls one threat-intel API with one credential. It is safe for concurrent use.
type apiClient struct {
	svc      service
	base     string            // no trailing slash
	headers  map[string]string // authentication, set on every request
	query    url.Values        // sent with every request (Shodan's key)
	insecure bool              // skip TLS verification (MISP lab setups)
}

func normalizeBaseURL(s string) string { return strings.TrimRight(strings.TrimSpace(s), "/") }

// newClient builds a client from a credential's data: baseUrl overrides the service's host, apiKey is sent as
// headerName (or as the `key` query parameter for Shodan, where headerName is "").
func newClient(svc service, data landflow.CredentialData, headerName string) *apiClient {
	c := &apiClient{svc: svc, base: normalizeBaseURL(data.String("baseUrl")), headers: map[string]string{}}
	if c.base == "" {
		c.base = svc.host
	}
	if key := strings.TrimSpace(data.String("apiKey")); key != "" {
		if headerName != "" {
			c.headers[headerName] = key
		} else {
			c.query = url.Values{"key": {key}}
		}
	}
	return c
}

func (c *apiClient) httpClient(ctx context.Context) *http.Client {
	if !c.insecure {
		return landflow.HTTPClient(ctx)
	}
	base := http.DefaultTransport.(*http.Transport).Clone()
	base.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec // opt-in per credential, for lab MISP servers
	return &http.Client{Transport: landflow.HTTPTransport(ctx, base)}
}

// apiError is a non-2xx answer: the HTTP status and the service's own message, never the key or the request body.
type apiError struct {
	svc        service
	status     int
	message    string
	retryAfter time.Duration // 429 only; 0 when the service gave none
}

func (e *apiError) Error() string {
	return fmt.Sprintf("%s API error %d: %s", e.svc.title, e.status, e.message)
}

// hint suggests the usual fix.
func (e *apiError) hint() string {
	switch {
	case e.status == http.StatusUnauthorized || e.status == http.StatusForbidden:
		return "Check the API key in the " + e.svc.title + " credential (and that its plan allows this call)."
	case e.status == http.StatusTooManyRequests:
		if e.retryAfter > 0 {
			return "Rate limit reached; retry after " + e.retryAfter.Round(time.Second).String() + " or enable Retry On Fail on the node."
		}
		return "Rate limit reached; retry later or enable Retry On Fail on the node."
	case e.status >= 500:
		return e.svc.title + " is unavailable; retry later."
	}
	return ""
}

func isNotFound(err error) bool {
	var ae *apiError
	return errors.As(err, &ae) && ae.status == http.StatusNotFound
}

// do sends one request (JSON body when body is non-nil) and decodes the JSON answer into out when non-nil. A 429 is
// retried once after its Retry-After (see maxRetryWait); other failures come back as *apiError.
func (c *apiClient) do(ctx context.Context, method, path string, query url.Values, body, out any) error {
	var payload []byte
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			return fmt.Errorf("encode the request: %v", err)
		}
	}
	q := url.Values{}
	for k, v := range c.query {
		q[k] = v
	}
	for k, v := range query {
		q[k] = v
	}
	target := c.base + path
	if len(q) > 0 {
		target += "?" + q.Encode()
	}
	for attempt := 1; ; attempt++ {
		err := c.once(ctx, method, target, payload, body != nil, out)
		var ae *apiError
		if attempt == 1 && errors.As(err, &ae) && ae.status == http.StatusTooManyRequests {
			wait := ae.retryAfter
			if wait <= 0 {
				wait = defaultRetryWait
			}
			if wait <= maxRetryWait {
				if serr := sleep(ctx, wait); serr != nil {
					return serr
				}
				continue
			}
		}
		return err
	}
}

func (c *apiClient) once(ctx context.Context, method, target string, payload []byte, hasBody bool, out any) error {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("%s: invalid request URL", c.svc.title)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "landflow-threat-intel/0.1")
	if hasBody {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range c.headers {
		req.Header.Set(k, v)
	}
	resp, err := c.httpClient(ctx).Do(req)
	if err != nil {
		return fmt.Errorf("%s request failed: %v", c.svc.title, transportError(err))
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		e := &apiError{svc: c.svc, status: resp.StatusCode, message: errorMessage(data, resp.StatusCode)}
		if resp.StatusCode == http.StatusTooManyRequests {
			e.retryAfter = parseRetryAfter(resp.Header.Get("Retry-After"))
		}
		return e
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("%s returned a response that is not JSON: %v", c.svc.title, err)
	}
	return nil
}

// transportError strips the request URL (which may carry a key) from a client error.
func transportError(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) && ue.Err != nil {
		return ue.Err
	}
	return err
}

// parseRetryAfter reads delta-seconds or an HTTP date; 0 when absent or in the past.
func parseRetryAfter(v string) time.Duration {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0
	}
	if n, err := strconv.ParseFloat(v, 64); err == nil && n > 0 {
		return time.Duration(n * float64(time.Second))
	}
	if t, err := http.ParseTime(v); err == nil {
		if d := time.Until(t); d > 0 {
			return d
		}
	}
	return 0
}

// errorMessage pulls the service's own message out of an error body. The services disagree on the envelope:
// {"error":{"message"}} (VirusTotal), {"errors":[{"detail"}]} (AbuseIPDB), {"message"} (GreyNoise, Shodan),
// {"description"} (urlscan.io), {"detail"} (OTX), {"error":"…"} (Shodan, MISP).
func errorMessage(body []byte, status int) string {
	var m map[string]any
	if json.Unmarshal(body, &m) == nil {
		for _, v := range []any{dig(m, "error", "message"), m["error"], dig(m, "errors", "0", "detail"), dig(m, "errors", "0", "message"),
			m["message"], m["description"], m["detail"], dig(m, "name")} {
			if s := strings.TrimSpace(str(v)); s != "" {
				return s
			}
		}
	}
	if s := strings.TrimSpace(string(body)); s != "" && !strings.HasPrefix(s, "<") && len(s) <= 300 {
		return s
	}
	return http.StatusText(status)
}
