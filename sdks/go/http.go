package landflow

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
)

// maxBodyBytes bounds request bodies (item batches can be large).
const maxBodyBytes = 64 << 20

// Handler returns an http.Handler serving exactly the HTTP_PATHS of the
// protocol, plus GET /metrics (Prometheus text) when telemetry serves it.
// Node failures are 200 with `error`; malformed requests are 400; unknown
// node types and credential types are 404. Execute, LoadOptions and
// TestCredentials continue the caller's trace from the traceparent,
// tracestate and baggage headers; health and manifest are not traced.
func (p *Plugin) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc(PathWellKnown, p.only(http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, p.WellKnown())
	}))
	mux.HandleFunc(PathManifest, p.only(http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, p.Manifest())
	}))
	mux.HandleFunc(PathHealth, p.only(http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, p.Health())
	}))
	mux.HandleFunc(PathExecute, p.only(http.MethodPost, p.handleExecute))
	mux.HandleFunc(PathLoadOptions, p.only(http.MethodPost, p.handleLoadOptions))
	mux.HandleFunc(PathTestCredentials, p.only(http.MethodPost, p.handleTestCredentials))
	mux.HandleFunc(PathWebhookMethod, p.only(http.MethodPost, p.handleWebhookMethod))
	mux.HandleFunc(PathWebhook, p.only(http.MethodPost, p.handleWebhook))
	mux.HandleFunc(PathMetrics, p.only(http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
		h := p.tel().MetricsHandler()
		if h == nil {
			writeError(w, http.StatusNotFound, "metrics are not served (LANDFLOW_METRICS_PROMETHEUS=false or telemetry disabled)")
			return
		}
		h.ServeHTTP(w, r)
	}))
	return mux
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

func (p *Plugin) handleExecute(w http.ResponseWriter, r *http.Request) {
	var req ExecuteRequest
	if !decodeBody(w, r, &req) {
		return
	}
	resp, err := p.Execute(p.tel().extractHTTP(r), &req)
	if err != nil {
		writeError(w, statusFor(err), err.Error())
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

func (p *Plugin) handleLoadOptions(w http.ResponseWriter, r *http.Request) {
	var req LoadOptionsRequest
	if !decodeBody(w, r, &req) {
		return
	}
	resp, err := p.LoadOptions(p.tel().extractHTTP(r), &req)
	if err != nil {
		writeError(w, statusFor(err), err.Error())
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (p *Plugin) handleTestCredentials(w http.ResponseWriter, r *http.Request) {
	var req TestCredentialsRequest
	if !decodeBody(w, r, &req) {
		return
	}
	resp, err := p.TestCredentials(p.tel().extractHTTP(r), &req)
	if err != nil {
		writeError(w, statusFor(err), err.Error())
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (p *Plugin) handleWebhookMethod(w http.ResponseWriter, r *http.Request) {
	var req WebhookMethodRequest
	if !decodeBody(w, r, &req) {
		return
	}
	resp, err := p.WebhookMethod(p.tel().extractHTTP(r), &req)
	if err != nil {
		writeError(w, statusFor(err), err.Error())
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (p *Plugin) handleWebhook(w http.ResponseWriter, r *http.Request) {
	var req WebhookRequest
	if !decodeBody(w, r, &req) {
		return
	}
	resp, err := p.ReceiveWebhook(p.tel().extractHTTP(r), &req)
	if err != nil {
		writeError(w, statusFor(err), err.Error())
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func statusFor(err error) int {
	switch {
	case errors.Is(err, ErrUnknownNode), errors.Is(err, ErrNoOptionsLoader), errors.Is(err, ErrUnknownCredentialType):
		return http.StatusNotFound
	case errors.Is(err, ErrBadRequest):
		return http.StatusBadRequest
	default:
		return http.StatusInternalServerError
	}
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
