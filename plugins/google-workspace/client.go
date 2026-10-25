package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"

	landflow "github.com/landflow/landflow/sdks/go"
)

// api is one Google API: its host and how it is named in metrics and errors.
// A credential's baseUrl replaces the host of all of them and keeps the paths.
type api struct {
	name  string // landflow.google.api_errors "api" attribute
	title string // shown in error messages
	host  string
}

var (
	apiSheets   = api{"sheets", "Google Sheets", "https://sheets.googleapis.com"}
	apiGmail    = api{"gmail", "Gmail", "https://gmail.googleapis.com"}
	apiDrive    = api{"drive", "Google Drive", "https://www.googleapis.com"}
	apiCalendar = api{"calendar", "Google Calendar", "https://www.googleapis.com"}
	apiDocs     = api{"docs", "Google Docs", "https://docs.googleapis.com"}
	apiUserinfo = api{"oauth2", "Google OAuth2", "https://www.googleapis.com"}
)

// client calls Google APIs with one credential's access tokens.
type client struct {
	ts      *tokenSource
	base    string            // credential baseUrl ("" = Google's hosts)
	metrics *landflow.Metrics // may be nil (credential tests)
}

// callContext is what newClient needs from an ExecuteContext or a
// LoadOptionsContext.
type callContext interface {
	context.Context
	Credentials(name ...string) landflow.CredentialData
	Metrics() *landflow.Metrics
}

// spanContext is a context that can open child spans: *ExecuteContext,
// *LoadOptionsContext and landflow.Span.
type spanContext interface {
	context.Context
	Span(name string, attrs landflow.Attrs, fn func(span landflow.Span) error) error
}

// newClient picks the credential matching the node's authentication
// parameter. If only the other type was sent (a picker inside a collection
// does not see the authentication parameter), that one is used.
func newClient(ctx callContext, authentication string) (*client, error) {
	want, other := credServiceAccount, credOAuth2
	if authentication == "oAuth2" {
		want, other = other, want
	}
	credType, data := want, ctx.Credentials(want)
	if data == nil {
		if d := ctx.Credentials(other); d != nil {
			credType, data = other, d
		}
	}
	if data == nil {
		return nil, landflow.NewNodeError("Credentials of type %q are required", want).
			WithDescription("Select or create a Google credential for this node; its type must match the Authentication setting.")
	}
	ts, err := newTokenSource(credType, data)
	if err != nil {
		return nil, landflow.NewNodeError("Invalid Google credential").WithDescription(err.Error())
	}
	return &client{ts: ts, base: normalizeBaseURL(data.String("baseUrl")), metrics: ctx.Metrics()}, nil
}

func normalizeBaseURL(s string) string { return strings.TrimRight(strings.TrimSpace(s), "/") }

// url builds the request URL for path on a's host (or the base URL override).
func (c *client) url(a api, path string, query url.Values) string {
	host := a.host
	if c.base != "" {
		host = c.base
	}
	if len(query) > 0 {
		return host + path + "?" + query.Encode()
	}
	return host + path
}

// do sends a request with an optional JSON body and decodes a JSON response
// into out (when non-nil).
func (c *client) do(ctx context.Context, a api, method, path string, query url.Values, body, out any) error {
	var payload []byte
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			return fmt.Errorf("encode the request: %v", err)
		}
	}
	return c.send(ctx, a, func() (*http.Request, error) {
		req, err := http.NewRequestWithContext(ctx, method, c.url(a, path, query), bytes.NewReader(payload))
		if err == nil && body != nil {
			req.Header.Set("Content-Type", "application/json; charset=utf-8")
		}
		return req, err
	}, func(resp *http.Response) error {
		if out == nil {
			return nil
		}
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil && !errors.Is(err, io.EOF) {
			return fmt.Errorf("%s returned a response that is not JSON: %v", a.title, err)
		}
		return nil
	})
}

// send adds the bearer token, sends the request built by build (called again
// for the retry), maps error responses and passes 2xx responses to handle.
// A 401 drops the cached token and retries once with a fresh one.
func (c *client) send(ctx context.Context, a api, build func() (*http.Request, error), handle func(*http.Response) error) error {
	for attempt := 1; ; attempt++ {
		token, _, err := c.ts.Token(ctx, c.metrics, false)
		if err != nil {
			return err
		}
		req, err := build()
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		if req.Header.Get("Accept") == "" {
			req.Header.Set("Accept", "application/json")
		}
		resp, err := landflow.HTTPClient(ctx).Do(req)
		if err != nil {
			c.countError(a, "network")
			return fmt.Errorf("%s request failed: %v", a.title, transportError(err))
		}
		if resp.StatusCode == http.StatusUnauthorized && attempt == 1 {
			drain(resp)
			c.ts.Invalidate(token)
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode > 299 {
			apiErr := readAPIError(a, resp)
			drain(resp)
			c.countError(a, statusClass(resp.StatusCode))
			apiErr.hint = c.hint(apiErr)
			return apiErr
		}
		err = handle(resp)
		drain(resp)
		return err
	}
}

func drain(resp *http.Response) {
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	_ = resp.Body.Close()
}

// transportError strips the request URL from a client error.
func transportError(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) && ue.Err != nil {
		return ue.Err
	}
	return err
}

func statusClass(status int) string {
	switch {
	case status >= 500:
		return "5xx"
	case status >= 400:
		return "4xx"
	}
	return "3xx"
}

func (c *client) countError(a api, class string) {
	c.metrics.Counter("landflow.google.api_errors", landflow.WithDescription("Failed Google API calls")).
		Add(1, landflow.Attrs{"api": a.name, "status_class": class})
}

// apiError is a non-2xx answer from a Google API: the HTTP status and
// Google's own message, never the token or the request body.
type apiError struct {
	api     api
	status  int
	message string
	reason  string // Google's status ("NOT_FOUND") or errors[0].reason
	hint    string
}

func (e *apiError) Error() string {
	return fmt.Sprintf("%s API error %d: %s", e.api.title, e.status, e.message)
}

// description is the NodeError description: a hint, or Google's reason.
func (e *apiError) description() string {
	if e.hint != "" {
		return e.hint
	}
	return e.reason
}

func readAPIError(a api, resp *http.Response) *apiError {
	e := &apiError{api: a, status: resp.StatusCode}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	var envelope struct {
		Error            json.RawMessage `json:"error"`
		ErrorDescription string          `json:"error_description"`
		Message          string          `json:"message"`
	}
	if json.Unmarshal(body, &envelope) == nil {
		var detail struct {
			Message string `json:"message"`
			Status  string `json:"status"`
			Errors  []struct {
				Reason  string `json:"reason"`
				Message string `json:"message"`
			} `json:"errors"`
		}
		var code string
		switch {
		case json.Unmarshal(envelope.Error, &detail) == nil && (detail.Message != "" || detail.Status != ""):
			e.message, e.reason = detail.Message, detail.Status
			if e.reason == "" && len(detail.Errors) > 0 {
				e.reason = detail.Errors[0].Reason
			}
		case json.Unmarshal(envelope.Error, &code) == nil:
			e.message, e.reason = envelope.ErrorDescription, code
		default:
			e.message = envelope.Message
		}
	}
	if e.message == "" {
		e.message = http.StatusText(resp.StatusCode)
	}
	return e
}

// hint suggests the usual fix for an API error.
func (c *client) hint(e *apiError) string {
	sa := c.ts.kind == authServiceAccount
	switch {
	case e.api.name == "gmail" && sa && c.ts.subject == "" && (e.status == 400 || e.status == 403):
		return "Gmail needs domain-wide delegation: set Impersonate a User on the service account credential."
	case sa && (e.status == 403 || e.status == 404) && e.api.name != "gmail":
		return "Check the ID, and share the spreadsheet, file or calendar with the service account (" + c.ts.email + ")."
	case e.status == 403 && strings.Contains(strings.ToLower(e.message), "scope"):
		return "The credential lacks a required OAuth scope (see the plugin README for the scope list)."
	case e.status == 401:
		return "Google rejected the access token; test the credential."
	case e.status == 429:
		return "Rate limit reached; retry later or enable Retry On Fail on the node."
	}
	return e.reason
}

// itemError turns err into a NodeError for input item i.
func itemError(i int, err error) error {
	var ae *apiError
	if errors.As(err, &ae) {
		return landflow.ItemError(i, "%s", ae.Error()).WithDescription(ae.description())
	}
	var ne *landflow.NodeError
	if errors.As(err, &ne) {
		cp := *ne
		cp.ItemIndex = &i
		return &cp
	}
	return landflow.ItemError(i, "%s", err.Error())
}

// userError is a NodeError without an item index (itemError adds it).
func userError(description, format string, args ...any) error {
	return landflow.NewNodeError(format, args...).WithDescription(description)
}

// paginate fetches pages inside one child span called name until there is no
// next page or want items were collected (want < 0: every page). page gets
// the page token and the number of items still wanted (-1: any) and returns
// how many items it collected and the next page token.
func paginate(ctx spanContext, name string, want int, page func(ctx context.Context, token string, remaining int) (int, string, error)) error {
	return ctx.Span(name, landflow.Attrs{"google.limit": want}, func(span landflow.Span) error {
		token, pages, total := "", 0, 0
		defer func() { span.SetAttributes(landflow.Attrs{"google.pages": pages, "google.items": total}) }()
		for {
			remaining := -1
			if want >= 0 {
				remaining = want - total
			}
			n, next, err := page(span, token, remaining)
			pages++
			total += n
			if err != nil {
				return err
			}
			if next == "" || (want >= 0 && total >= want) {
				return nil
			}
			token = next
		}
	})
}

// pageSize clamps the remaining item count to an API's page size.
func pageSize(remaining, limit int) int {
	if remaining < 0 || remaining > limit {
		return limit
	}
	return max(remaining, 1)
}

// forEach runs fn(0..n-1) with at most workers in flight and returns the
// error of the lowest index that failed.
func forEach(n, workers int, fn func(i int) error) error {
	errs := make([]error, n)
	sem := make(chan struct{}, max(workers, 1))
	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer func() { <-sem; wg.Done() }()
			errs[i] = fn(i)
		}()
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	return nil
}
