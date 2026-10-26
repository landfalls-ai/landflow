package landflow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// maxBodyBytes bounds request bodies (item batches can be large).
const maxBodyBytes = 64 << 20

// Handler returns an http.Handler serving exactly the HTTP_PATHS of the
// protocol, plus GET /metrics (Prometheus text) when telemetry serves it.
// Node failures are 200 with `error`; malformed requests are 400; unknown
// node types and credential types are 404. Execute, LoadOptions and
// TestCredentials continue the caller's trace from the traceparent,
// tracestate and baggage headers; health and manifest are not traced.
//
// It is the HTTP binding over the plugin's Dispatcher; the request context
// (cancelled when the client disconnects) reaches node code.
func (p *Plugin) Handler() http.Handler { return p.Dispatcher().Handler() }

// httpHandler is the HTTP face of a dispatcher.
type httpHandler struct {
	d *Dispatcher
}

// Handler returns the protocol's HTTP+JSON face over this dispatcher (see Plugin.Handler).
func (d *Dispatcher) Handler() http.Handler {
	h := &httpHandler{d: d}
	p := d.p
	mux := http.NewServeMux()
	mux.HandleFunc(PathWellKnown, p.only(http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, d.WellKnown())
	}))
	mux.HandleFunc(PathManifest, p.only(http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
		// Kubernetes discovery: prove LANDFLOW_REGISTRY_SECRET when the host sends a challenge (registry_proof.go).
		if proof := p.answerRegistryChallenge(r.Header.Get(RegistryChallengeHeader)); proof != "" {
			w.Header().Set(RegistryProofHeader, proof)
		}
		writeJSON(w, http.StatusOK, d.Manifest())
	}))
	mux.HandleFunc(PathHealth, p.only(http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, d.Health())
	}))
	mux.HandleFunc(PathExecute, p.only(http.MethodPost, h.handleExecute))
	mux.HandleFunc(PathLoadOptions, p.only(http.MethodPost, h.handleLoadOptions))
	mux.HandleFunc(PathTestCredentials, p.only(http.MethodPost, h.handleTestCredentials))
	mux.HandleFunc(PathWebhookMethod, p.only(http.MethodPost, h.handleWebhookMethod))
	mux.HandleFunc(PathWebhook, p.only(http.MethodPost, h.handleWebhook))
	mux.HandleFunc(PathMetrics, p.only(http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
		mh := p.tel().MetricsHandler()
		if mh == nil {
			writeError(w, http.StatusNotFound, "metrics are not served (LANDFLOW_METRICS_PROMETHEUS=false or telemetry disabled)")
			return
		}
		mh.ServeHTTP(w, r)
	}))
	return mux
}

// DeadlineHeader is the request header carrying the call's deadline as an
// epoch in milliseconds (docs/transports.md "SDK side"). Absent or
// unparsable: no deadline beyond the connection itself.
const DeadlineHeader = "x-landflow-deadline"

// httpCall is the CallOptions of an HTTP request: the request context carries
// the client's disconnect, the x-landflow-deadline header the deadline.
func httpCall(r *http.Request) CallOptions {
	opts := CallOptions{Transport: "http"}
	if raw := strings.TrimSpace(r.Header.Get(DeadlineHeader)); raw != "" {
		if ms, err := strconv.ParseInt(raw, 10, 64); err == nil && ms > 0 {
			opts.Deadline = time.UnixMilli(ms)
		}
	}
	return opts
}

func (p *Plugin) only(method string, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != method && !(method == http.MethodGet && r.Method == http.MethodHead) {
			w.Header().Set("Allow", method)
			writeError(w, http.StatusMethodNotAllowed, fmt.Sprintf("method %s not allowed; use %s", r.Method, method))
			return
		}
		h(w, r)
	}
}

func (h *httpHandler) handleExecute(w http.ResponseWriter, r *http.Request) {
	var req ExecuteRequest
	if !decodeBody(w, r, &req) {
		return
	}
	resp, err := h.d.Execute(h.d.p.tel().extractHTTP(r), &req, httpCall(r))
	if err != nil {
		writeDispatchError(w, err)
		return
	}
	data, err := json.Marshal(resp)
	if err != nil {
		// A node emitting NaN, channels, ... is a node failure, not a server bug.
		data, _ = json.Marshal(unserializableOutput(resp, err))
	}
	writeRaw(w, http.StatusOK, data)
}

func unserializableOutput(resp *ExecuteResponse, err error) *ExecuteResponse {
	return &ExecuteResponse{
		Outputs: [][]Item{},
		Logs:    resp.Logs,
		Error:   &NodeErrorPayload{Message: "node output is not JSON-serializable: " + err.Error()},
	}
}

func (h *httpHandler) handleLoadOptions(w http.ResponseWriter, r *http.Request) {
	var req LoadOptionsRequest
	if !decodeBody(w, r, &req) {
		return
	}
	resp, err := h.d.LoadOptions(h.d.p.tel().extractHTTP(r), &req, httpCall(r))
	if err != nil {
		writeDispatchError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *httpHandler) handleTestCredentials(w http.ResponseWriter, r *http.Request) {
	var req TestCredentialsRequest
	if !decodeBody(w, r, &req) {
		return
	}
	resp, err := h.d.TestCredentials(h.d.p.tel().extractHTTP(r), &req, httpCall(r))
	if err != nil {
		writeDispatchError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *httpHandler) handleWebhookMethod(w http.ResponseWriter, r *http.Request) {
	var req WebhookMethodRequest
	if !decodeBody(w, r, &req) {
		return
	}
	resp, err := h.d.WebhookMethod(h.d.p.tel().extractHTTP(r), &req, httpCall(r))
	if err != nil {
		writeDispatchError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *httpHandler) handleWebhook(w http.ResponseWriter, r *http.Request) {
	var req WebhookRequest
	if !decodeBody(w, r, &req) {
		return
	}
	resp, err := h.d.ReceiveWebhook(h.d.p.tel().extractHTTP(r), &req, httpCall(r))
	if err != nil {
		writeDispatchError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// StatusClientClosedRequest is nginx's 499: the caller cancelled the call
// before it finished (the connection closed). Nothing standard fits better,
// and the TypeScript SDK answers the same.
const StatusClientClosedRequest = 499

// statusFor maps a dispatcher error to its HTTP status, as every SDK does:
// unknown node or credential type 404, capacity 429, deadline 504, cancel 499.
func statusFor(err error) int {
	switch {
	case errors.Is(err, ErrUnknownNode), errors.Is(err, ErrNoOptionsLoader), errors.Is(err, ErrUnknownCredentialType):
		return http.StatusNotFound
	case errors.Is(err, ErrBadRequest):
		return http.StatusBadRequest
	case errors.Is(err, ErrOverloaded):
		return http.StatusTooManyRequests
	case errors.Is(err, context.DeadlineExceeded):
		return http.StatusGatewayTimeout
	case errors.Is(err, context.Canceled):
		return StatusClientClosedRequest
	default:
		return http.StatusInternalServerError
	}
}

// writeDispatchError answers a refused or failed call; a capacity refusal
// carries Retry-After: 1 so the host (or a proxy) retries elsewhere or later.
func writeDispatchError(w http.ResponseWriter, err error) {
	if errors.Is(err, ErrOverloaded) {
		w.Header().Set("Retry-After", "1")
	}
	writeError(w, statusFor(err), err.Error())
}

// decodeBody parses a JSON body; on failure it writes a 400 and returns false.
func decodeBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	body := http.MaxBytesReader(w, r.Body, maxBodyBytes)
	dec := json.NewDecoder(body)
	if err := dec.Decode(dst); err != nil {
		msg := "malformed JSON body: " + err.Error()
		if errors.Is(err, io.EOF) {
			msg = "request body is empty"
		}
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeError(w, http.StatusRequestEntityTooLarge, "request body too large")
			return false
		}
		writeError(w, http.StatusBadRequest, msg)
		return false
	}
	if dec.More() {
		writeError(w, http.StatusBadRequest, "malformed JSON body: trailing data after the JSON value")
		return false
	}
	return true
}

type errorBody struct {
	Error NodeErrorPayload `json:"error"`
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, errorBody{Error: NodeErrorPayload{Message: msg}})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	data, err := json.Marshal(v)
	if err != nil {
		log.Printf("landflow: encode response: %v", err)
		status = http.StatusInternalServerError
		data, _ = json.Marshal(errorBody{Error: NodeErrorPayload{
			Message: "plugin produced a response that is not JSON-serializable: " + err.Error(),
		}})
	}
	writeRaw(w, status, data)
}

func writeRaw(w http.ResponseWriter, status int, data []byte) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(append(data, '\n'))
}
