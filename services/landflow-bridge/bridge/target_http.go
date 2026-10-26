package bridge

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	landflow "github.com/landflow/landflow/sdks/go"
	"github.com/landflow/landflow/sdks/go/transport"
)

// httpTarget forwards calls over the HTTP+JSON face: the brokered body is the HTTP body as is, the deadline travels
// as x-landflow-deadline (epoch ms) and a cancelled ctx closes the request, which cancels the call on every SDK.
type httpTarget struct {
	base   string
	client *http.Client
}

func newHTTPTarget(u *url.URL) (*httpTarget, error) {
	base := strings.TrimRight(u.String(), "/")
	return &httpTarget{base: base, client: &http.Client{Transport: &http.Transport{
		MaxIdleConns: 64, MaxIdleConnsPerHost: 64, IdleConnTimeout: 90 * time.Second,
		DialContext: (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
	}}}, nil
}

func (t *httpTarget) URL() string  { return t.base }
func (t *httpTarget) Close() error { t.client.CloseIdleConnections(); return nil }

func (t *httpTarget) Manifest(ctx context.Context) (json.RawMessage, error) {
	return t.do(ctx, http.MethodGet, landflow.PathManifest, nil, time.Time{})
}

var httpPaths = map[transport.Method]string{
	transport.MethodExecute:         landflow.PathExecute,
	transport.MethodLoadOptions:     landflow.PathLoadOptions,
	transport.MethodTestCredentials: landflow.PathTestCredentials,
	transport.MethodWebhookMethod:   landflow.PathWebhookMethod,
	transport.MethodReceiveWebhook:  landflow.PathWebhook,
}

func (t *httpTarget) Call(ctx context.Context, method transport.Method, body json.RawMessage, deadline time.Time) (json.RawMessage, error) {
	switch method {
	case transport.MethodGetManifest:
		return t.do(ctx, http.MethodGet, landflow.PathManifest, nil, deadline)
	case transport.MethodHealth:
		return t.do(ctx, http.MethodGet, landflow.PathHealth, nil, deadline)
	}
	path, ok := httpPaths[method]
	if !ok {
		return nil, dispatchErr(transport.CodeNotFound, "unknown method %q", method)
	}
	if len(body) == 0 {
		return nil, dispatchErr(transport.CodeBadRequest, "request body is empty")
	}
	return t.do(ctx, http.MethodPost, path, body, deadline)
}

func (t *httpTarget) do(ctx context.Context, verb, path string, body []byte, deadline time.Time) (json.RawMessage, error) {
	if !deadline.IsZero() {
		var cancel context.CancelFunc
		ctx, cancel = context.WithDeadline(ctx, deadline)
		defer cancel()
	}
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, verb, t.base+path, reader)
	if err != nil {
		return nil, dispatchErr(transport.CodeInternal, "%v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if !deadline.IsZero() {
		req.Header.Set(landflow.DeadlineHeader, strconv.FormatInt(deadline.UnixMilli(), 10))
	}
	resp, err := t.client.Do(req)
	if err != nil {
		if e := ctxErr(ctx); e != nil {
			return nil, e
		}
		return nil, dispatchErr(transport.CodeUnavailable, "plugin unreachable over HTTP: %v", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxGRPCMessageBytes+1))
	if err != nil {
		if e := ctxErr(ctx); e != nil {
			return nil, e
		}
		return nil, dispatchErr(transport.CodeInternal, "reading the plugin's response: %v", err)
	}
	if resp.StatusCode == http.StatusOK {
		if !json.Valid(data) {
			return nil, dispatchErr(transport.CodeInternal, "plugin answered %s with a body that is not JSON", path)
		}
		return json.RawMessage(data), nil
	}
	if e := ctxErr(ctx); e != nil {
		return nil, e
	}
	return nil, httpError(resp.StatusCode, data, resp.Header.Get("Retry-After"))
}

// httpError maps an HTTP status onto the lferror vocabulary (the kit's table): 400 bad_request, 404 not_found,
// 413 too_large, 429 capacity (with Retry-After), 499 cancelled, 503 unavailable, 504 expired, else internal. The message is the body's
// error.message when the SDK wrote one.
func httpError(status int, data []byte, retryAfter string) error {
	msg := fmt.Sprintf("plugin answered HTTP %d", status)
	var body struct {
		Error json.RawMessage `json:"error"`
	}
	if json.Unmarshal(data, &body) == nil && len(body.Error) > 0 {
		var payload struct {
			Message string `json:"message"`
		}
		var text string
		switch {
		case json.Unmarshal(body.Error, &payload) == nil && payload.Message != "":
			text = payload.Message
		case json.Unmarshal(body.Error, &text) == nil && text != "":
		}
		if text != "" {
			msg = text
		}
	}
	switch status {
	case http.StatusBadRequest:
		return dispatchErr(transport.CodeBadRequest, "%s", msg)
	case http.StatusNotFound, http.StatusNotImplemented:
		return dispatchErr(transport.CodeNotFound, "%s", msg)
	case http.StatusRequestEntityTooLarge:
		return dispatchErr(transport.CodeTooLarge, "%s", msg)
	case http.StatusTooManyRequests:
		e := dispatchErr(transport.CodeCapacity, "%s", msg)
		if secs, err := strconv.Atoi(strings.TrimSpace(retryAfter)); err == nil && secs > 0 {
			e.Details = map[string]any{retryAfterKey: time.Duration(secs) * time.Second}
		}
		return e
	case landflow.StatusClientClosedRequest:
		return dispatchErr(transport.CodeCancelled, "%s", msg)
	case http.StatusServiceUnavailable:
		return dispatchErr(transport.CodeUnavailable, "%s", msg)
	case http.StatusGatewayTimeout:
		return dispatchErr(transport.CodeExpired, "%s", msg)
	default:
		return dispatchErr(transport.CodeInternal, "%s", msg)
	}
}
