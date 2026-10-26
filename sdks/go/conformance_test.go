package landflow_test

// The protocol conformance kit (packages/protocol/conformance) run against every face of the Go SDK: HTTP, gRPC,
// messaging (over the in-memory driver of sdks/go/transport) and MCP (the 2026-07-28 wire at /mcp). One runner per
// face knows how to send a case over its binding and maps its own signals onto the kit's outcome and error codes
// (README "Transport error codes"); the assertions are shared. The mirror of packages/sdk/test/conformance.test.ts.
//
// Runner defaults: a 3 s deadline when a case gives none (the kit says 30 s; the plugin's nodes answer in
// milliseconds and the tampered-event cases are only resolved by the deadline).

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	landflow "github.com/landflow/landflow/sdks/go"
	"github.com/landflow/landflow/sdks/go/conformance"
	pb "github.com/landflow/landflow/sdks/go/landflowpb"
	"github.com/landflow/landflow/sdks/go/mcpface"
	"github.com/landflow/landflow/sdks/go/transport"
	"github.com/landflow/landflow/sdks/go/transport/memory"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
)

// Stream T3-D's port range: 7460–7479 (7462/7463 are the TypeScript runner's).
const (
	confHTTPPort   = 7464
	confGRPCPort   = 7465
	confMCPToken   = "conformance-token"
	confDeadline   = 3 * time.Second
	confSecret     = "conformance-transport-secret"
	confMaxMsgSize = 256 * 1024
)

// ---------------------------------------------------------------------------
// The kit
// ---------------------------------------------------------------------------

type confCall struct {
	Method          string           `json:"method"`
	Node            string           `json:"node"`
	Parameters      map[string]any   `json:"parameters"`
	Items           []map[string]any `json:"items"`
	DeadlineMs      *int             `json:"deadlineMs"`
	CancelAfterMs   *int             `json:"cancelAfterMs"`
	IdempotencyKey  string           `json:"idempotencyKey"`
	Repeat          int              `json:"repeat"`
	PadBytes        int              `json:"padBytes"`
	Tamper          string           `json:"tamper"`
	LoadOptions     *struct{ Method string }
	TestCredentials *struct {
		CredentialType string         `json:"credentialType"`
		Data           map[string]any `json:"data"`
	} `json:"testCredentials"`
	Credentials map[string]any `json:"credentials"`
}

type confExpect struct {
	Outcome       json.RawMessage    `json:"outcome"`
	Code          string             `json:"code"`
	Outputs       [][]map[string]any `json:"outputs"`
	ErrorMessage  string             `json:"errorMessage"`
	Ran           *bool              `json:"ran"`
	SignalAborted bool               `json:"signalAborted"`
	WithinMs      *int               `json:"withinMs"`
	DeliveryMode  string             `json:"deliveryMode"`
	Count         *int               `json:"count"`
}

func (e confExpect) outcomes() []string {
	var one string
	if json.Unmarshal(e.Outcome, &one) == nil {
		return []string{one}
	}
	var many []string
	_ = json.Unmarshal(e.Outcome, &many)
	return many
}

type confCase struct {
	ID          string     `json:"id"`
	Description string     `json:"description"`
	Applies     []string   `json:"applies"`
	Call        confCall   `json:"call"`
	Expect      confExpect `json:"expect"`
}

type confSuite struct {
	Kit     string     `json:"kit"`
	Suite   string     `json:"suite"`
	Applies []string   `json:"applies"`
	Cases   []confCase `json:"cases"`
}

func conformanceKitDir(t *testing.T) string {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	dir := filepath.Join(filepath.Dir(file), "..", "..", "packages", "protocol", "conformance")
	if _, err := os.Stat(filepath.Join(dir, "plugin-manifest.json")); err != nil {
		t.Skipf("conformance kit not found at %s: %v", dir, err)
	}
	return dir
}

func appliesTo(applies []string, face string) bool {
	if len(applies) == 0 {
		return true
	}
	for _, a := range applies {
		if a == face {
			return true
		}
	}
	return false
}

// loadSuites returns the behavioural suites with the cases that apply to face.
func loadSuites(t *testing.T, face string) []confSuite {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(conformanceKitDir(t), "fixtures"))
	if err != nil {
		t.Fatal(err)
	}
	var suites []confSuite
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".json") || e.Name() == "mcp-tools.json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(conformanceKitDir(t), "fixtures", e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		var suite confSuite
		if err := json.Unmarshal(data, &suite); err != nil {
			t.Fatalf("%s: %v", e.Name(), err)
		}
		if suite.Kit != "landflow.conformance/v1" || !appliesTo(suite.Applies, face) {
			continue
		}
		var cases []confCase
		for _, c := range suite.Cases {
			if appliesTo(c.Applies, face) {
				cases = append(cases, c)
			}
		}
		suite.Cases = cases
		suites = append(suites, suite)
	}
	return suites
}

// ---------------------------------------------------------------------------
// Outcomes and timers
// ---------------------------------------------------------------------------

type outcome struct {
	Outcome      string // reply | node-error | transport-error | no-reply | skipped
	Code         string
	Response     *landflow.ExecuteResponse
	ErrorMessage string
	Elapsed      time.Duration
	Reason       string
}

func outcomeOf(resp *landflow.ExecuteResponse, elapsed time.Duration) outcome {
	if resp.Error != nil {
		return outcome{Outcome: "node-error", Response: resp, ErrorMessage: resp.Error.Message, Elapsed: elapsed}
	}
	return outcome{Outcome: "reply", Response: resp, Elapsed: elapsed}
}

func transportError(code, msg string, elapsed time.Duration) outcome {
	return outcome{Outcome: "transport-error", Code: code, ErrorMessage: msg, Elapsed: elapsed}
}

// callTimers: the deadline (client-side `expired`) and cancelAfterMs (`cancelled`). ctx ends for both; cancelCtx only
// for the cancel (gRPC and messaging carry the deadline themselves).
type callTimers struct {
	deadline       time.Time
	ctx, cancelCtx context.Context
	stop           func()
	expired        bool
	cancelled      bool
}

func newTimers(call confCall) *callTimers {
	deadlineMs := int(confDeadline / time.Millisecond)
	if call.DeadlineMs != nil {
		deadlineMs = *call.DeadlineMs
	}
	// Whole milliseconds, like the x-landflow-deadline header the server reads (so server and client agree on the instant).
	ct := &callTimers{deadline: time.UnixMilli(time.Now().Add(time.Duration(deadlineMs) * time.Millisecond).UnixMilli())}
	ctx, cancelBoth := context.WithCancel(context.Background())
	cancelCtx, cancelOnly := context.WithCancel(context.Background())
	ct.ctx, ct.cancelCtx = ctx, cancelCtx
	var timers []*time.Timer
	if deadlineMs <= 0 {
		ct.expired = true
	} else {
		timers = append(timers, time.AfterFunc(time.Duration(deadlineMs)*time.Millisecond, func() { ct.expired = true; cancelBoth() }))
	}
	if call.CancelAfterMs != nil {
		// A cancel "at 0 ms" still lands after the call was sent (TypeScript's setTimeout(0) does the same): the kit's
		// cancel-before-dispatch is about the plugin's side, not an abort before publishing.
		after := max(time.Duration(*call.CancelAfterMs)*time.Millisecond, 10*time.Millisecond)
		timers = append(timers, time.AfterFunc(after, func() { ct.cancelled = true; cancelBoth(); cancelOnly() }))
	}
	ct.stop = func() {
		for _, tm := range timers {
			tm.Stop()
		}
		cancelBoth()
		cancelOnly()
	}
	return ct
}

// why is `expired` over `cancelled` when both fired; "" when neither did.
func (ct *callTimers) why() string {
	if ct.expired {
		return "expired"
	}
	if ct.cancelled {
		return "cancelled"
	}
	return ""
}

func (ct *callTimers) isLate() bool { return !time.Now().Before(ct.deadline) }

// executeRequest builds the ExecuteRequest of a case (also for a node the plugin does not have).
func executeRequest(manifest landflow.PluginManifest, call confCall) *landflow.ExecuteRequest {
	params := map[string]any{}
	for k, v := range call.Parameters {
		params[k] = v
	}
	if call.PadBytes > 0 {
		msg, _ := params["message"].(string)
		if len(msg) < call.PadBytes {
			msg += strings.Repeat("x", call.PadBytes-len(msg))
		}
		params["message"] = msg
	}
	items := []landflow.Item{{JSON: map[string]any{}}}
	rawItems := []any{}
	if call.Items != nil {
		items = nil
		rawItems = nil
		for _, it := range call.Items {
			rawItems = append(rawItems, it)
			j, _ := it["json"].(map[string]any)
			items = append(items, landflow.Item{JSON: j})
		}
	}
	name, version := call.Node, 1
	for _, n := range manifest.Nodes {
		if n.Name == call.Node {
			name = n.DisplayName
			for _, v := range n.Version {
				if v > version {
					version = v
				}
			}
		}
	}
	req := &landflow.ExecuteRequest{
		Protocol: landflow.ProtocolVersion, ExecutionID: "ex_" + call.Node, Mode: landflow.ModeManual,
		Node:       landflow.NodeRef{ID: "n-" + call.Node, Name: name, Type: conformance.PluginID + "." + call.Node, TypeVersion: version},
		Parameters: params, ItemParameters: make([]map[string]any, len(items)), Inputs: [][]landflow.Item{items},
		IdempotencyKey: call.IdempotencyKey, Credentials: call.Credentials,
	}
	for i := range req.ItemParameters {
		req.ItemParameters[i] = map[string]any{}
	}
	_ = rawItems
	return req
}

// rawExecuteBody is the request as JSON, with a malformed item kept malformed (the kit's `"json": "not-an-object"`).
func rawExecuteBody(manifest landflow.PluginManifest, call confCall) []byte {
	req := executeRequest(manifest, call)
	data, _ := json.Marshal(req)
	if call.Items != nil {
		var generic map[string]any
		_ = json.Unmarshal(data, &generic)
		generic["inputs"] = []any{call.Items}
		data, _ = json.Marshal(generic)
	}
	return data
}

type runner interface {
	face() string
	run(c confCase) outcome
}

func repeated(c confCase, once func() outcome) outcome {
	n := c.Call.Repeat
	if n < 1 {
		n = 1
	}
	var last outcome
	for i := 0; i < n; i++ {
		last = once()
	}
	return last
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

var httpStatusCodes = map[int]string{400: "bad_request", 404: "not_found", 413: "too_large", 429: "unavailable", 499: "cancelled", 500: "internal", 503: "unavailable", 504: "expired"}

type httpRunner struct {
	base     string
	manifest landflow.PluginManifest
}

func (httpRunner) face() string { return "http" }

func (r httpRunner) post(path string, body []byte, call confCall) outcome {
	timers := newTimers(call)
	defer timers.stop()
	started := time.Now()
	if timers.why() == "expired" {
		return transportError("expired", "", 0)
	}
	req, _ := http.NewRequestWithContext(timers.ctx, http.MethodPost, r.base+path, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(landflow.DeadlineHeader, strconv.FormatInt(timers.deadline.UnixMilli(), 10))
	resp, err := http.DefaultClient.Do(req)
	elapsed := time.Since(started)
	if err != nil {
		if why := timers.why(); why != "" {
			return transportError(why, err.Error(), elapsed)
		}
		return transportError("internal", err.Error(), elapsed)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	// A reply that arrives after the deadline is ignored by the caller (the deadline timer is what the host sees).
	if timers.isLate() {
		return transportError("expired", "", elapsed)
	}
	if resp.StatusCode == http.StatusOK {
		var out landflow.ExecuteResponse
		if err := json.Unmarshal(data, &out); err != nil {
			return transportError("internal", err.Error(), elapsed)
		}
		return outcomeOf(&out, elapsed)
	}
	code, ok := httpStatusCodes[resp.StatusCode]
	if !ok {
		code = "http_" + strconv.Itoa(resp.StatusCode)
	}
	var body2 struct {
		Error struct{ Message string }
	}
	_ = json.Unmarshal(data, &body2)
	return transportError(code, body2.Error.Message, elapsed)
}

func (r httpRunner) run(c confCase) outcome {
	return repeated(c, func() outcome {
		call := c.Call
		switch call.Method {
		case "execute":
			return r.post(landflow.PathExecute, rawExecuteBody(r.manifest, call), call)
		case "health":
			resp, err := http.Get(r.base + landflow.PathHealth)
			if err != nil || resp.StatusCode != 200 {
				return transportError("unavailable", fmt.Sprint(err), 0)
			}
			resp.Body.Close()
			return outcome{Outcome: "reply"}
		case "testCredentials":
			body, _ := json.Marshal(call.TestCredentials)
			return r.post(landflow.PathTestCredentials, body, call)
		case "loadOptions":
			body, _ := json.Marshal(map[string]any{"nodeType": conformance.PluginID + "." + call.Node, "method": call.LoadOptions.Method, "parameters": map[string]any{}})
			return r.post(landflow.PathLoadOptions, body, call)
		}
		return outcome{Outcome: "skipped", Reason: call.Method + " over HTTP is not part of this runner"}
	})
}

// ---------------------------------------------------------------------------
// gRPC
// ---------------------------------------------------------------------------

var grpcStatusCodes = map[codes.Code]string{
	codes.NotFound: "not_found", codes.InvalidArgument: "bad_request", codes.DeadlineExceeded: "expired", codes.Canceled: "cancelled",
	codes.ResourceExhausted: "unavailable", codes.Internal: "internal", codes.Unavailable: "no_consumers", codes.Unauthenticated: "unauthenticated",
}

type grpcRunner struct {
	client   pb.PluginServiceClient
	manifest landflow.PluginManifest
}

func (grpcRunner) face() string { return "grpc" }

func (r grpcRunner) unary(call confCall, do func(ctx context.Context) (*landflow.ExecuteResponse, error)) outcome {
	timers := newTimers(call)
	defer timers.stop()
	if timers.why() == "expired" {
		return transportError("expired", "", 0)
	}
	ctx, cancel := context.WithDeadline(timers.cancelCtx, timers.deadline)
	defer cancel()
	started := time.Now()
	resp, err := do(ctx)
	elapsed := time.Since(started)
	if err != nil {
		code := timers.why()
		if code == "" {
			if st, ok := status.FromError(err); ok {
				code = grpcStatusCodes[st.Code()]
				if code == "" {
					code = "grpc_" + st.Code().String()
				}
			} else {
				code = "internal"
			}
		}
		msg := err.Error()
		if st, ok := status.FromError(err); ok {
			msg = st.Message()
		}
		return transportError(code, msg, elapsed)
	}
	if resp == nil {
		return outcome{Outcome: "reply", Elapsed: elapsed}
	}
	return outcomeOf(resp, elapsed)
}

func (r grpcRunner) run(c confCase) outcome {
	return repeated(c, func() outcome {
		call := c.Call
		switch call.Method {
		case "execute":
			return r.unary(call, func(ctx context.Context) (*landflow.ExecuteResponse, error) {
				req := executeRequest(r.manifest, call)
				if call.Items != nil {
					// A malformed item cannot be a landflow.Item; send it as raw JSON like the wire would.
					for i, it := range call.Items {
						if _, ok := it["json"].(map[string]any); !ok {
							req.Inputs[0][i] = landflow.Item{JSON: nil}
						}
					}
				}
				msg, err := landflow.ExecuteRequestToProto(req)
				if err != nil {
					return nil, status.Error(codes.InvalidArgument, err.Error())
				}
				if call.Items != nil {
					for i, it := range call.Items {
						if _, ok := it["json"].(map[string]any); !ok {
							raw, _ := json.Marshal(it["json"])
							msg.Inputs[0].Items[i].Json = &pb.DynamicValue{Json: raw}
						}
					}
				}
				out, err := r.client.Execute(ctx, msg)
				if err != nil {
					return nil, err
				}
				return landflow.ExecuteResponseFromProto(out)
			})
		case "health":
			return r.unary(call, func(ctx context.Context) (*landflow.ExecuteResponse, error) {
				_, err := r.client.Health(ctx, &pb.HealthRequest{})
				return nil, err
			})
		case "testCredentials":
			return r.unary(call, func(ctx context.Context) (*landflow.ExecuteResponse, error) {
				data, _ := json.Marshal(call.TestCredentials.Data)
				_, err := r.client.TestCredentials(ctx, &pb.TestCredentialsRequest{CredentialType: call.TestCredentials.CredentialType, Data: &pb.DynamicValue{Json: data}})
				return nil, err
			})
		case "loadOptions":
			return r.unary(call, func(ctx context.Context) (*landflow.ExecuteResponse, error) {
				_, err := r.client.LoadOptions(ctx, &pb.LoadOptionsRequest{NodeType: conformance.PluginID + "." + call.Node, Method: call.LoadOptions.Method, Parameters: &pb.DynamicValue{Json: []byte("{}")}})
				return nil, err
			})
		}
		return outcome{Outcome: "skipped", Reason: call.Method + " over gRPC is not part of this runner"}
	})
}

// ---------------------------------------------------------------------------
// Messaging (in-memory driver)
// ---------------------------------------------------------------------------

type messagingRunner struct {
	client   *transport.Client
	broker   *memory.Broker
	manifest landflow.PluginManifest
	hooks    *conformance.Hooks
	seen     *[]transport.DispatchContext
}

func (messagingRunner) face() string { return "messaging" }

func (r messagingRunner) lastDelivery() string {
	if len(*r.seen) == 0 {
		return ""
	}
	return string((*r.seen)[len(*r.seen)-1].Delivery)
}

func (r messagingRunner) tampered(tamper string) func() {
	if tamper == "" || tamper == "manifestHash" {
		return func() {}
	}
	requestChannel := r.client.Names.Request(conformance.PluginID)
	return r.broker.Tap(func(channel string, event transport.WireEvent) (transport.WireEvent, bool) {
		if channel != requestChannel {
			return event, true
		}
		headers := map[string]string{}
		for k, v := range event.Headers {
			headers[k] = v
		}
		body := append([]byte(nil), event.Body...)
		if tamper == "signature" {
			sig := headers["lfsig"]
			if strings.HasPrefix(sig, "0") {
				sig = "1" + sig[1:]
			} else {
				sig = "0" + sig[1:]
			}
			headers["lfsig"] = sig
		} else if len(body) > 0 {
			body[len(body)-1] ^= 0xff
		}
		return transport.WireEvent{Headers: headers, Body: body}, true
	})
}

func (r messagingRunner) isIdempotent(node string) bool {
	for _, n := range r.manifest.Nodes {
		if n.Name == node {
			return n.Idempotent
		}
	}
	return false
}

func (r messagingRunner) invoke(method transport.Method, body any, call confCall) outcome {
	timers := newTimers(call)
	defer timers.stop()
	untap := r.tampered(call.Tamper)
	defer untap()
	opts := transport.CallOptions{Deadline: timers.deadline, IdempotencyKey: call.IdempotencyKey, Delivery: transport.AtMostOnce}
	// Like the host: at least once for every method but Execute, and for an Execute of an idempotent node.
	if method != transport.MethodExecute || r.isIdempotent(call.Node) {
		opts.Delivery = transport.AtLeastOnce
	}
	if call.Tamper == "manifestHash" {
		opts.ManifestHash = "ffffffffffffffff"
	}
	started := time.Now()
	reply, err := r.client.Call(timers.cancelCtx, conformance.PluginID, method, body, opts)
	elapsed := time.Since(started)
	if err != nil {
		if timers.why() == "expired" {
			return transportError("expired", err.Error(), elapsed)
		}
		var te *transport.TimeoutError
		var ce *transport.CancelledError
		var ue *transport.UndeliverableError
		var me *transport.ManifestMismatchError
		var re *transport.RemoteError
		switch {
		case errors.As(err, &te):
			return transportError("expired", err.Error(), elapsed)
		case errors.As(err, &ce):
			return transportError("cancelled", err.Error(), elapsed)
		case errors.As(err, &ue):
			return transportError(string(ue.Reason), err.Error(), elapsed)
		case errors.As(err, &me):
			return transportError("manifest_mismatch", err.Error(), elapsed)
		case errors.As(err, &re):
			return transportError(string(re.RemoteCode), err.Error(), elapsed)
		}
		return transportError("internal", err.Error(), elapsed)
	}
	if method != transport.MethodExecute {
		return outcome{Outcome: "reply", Elapsed: elapsed}
	}
	var resp landflow.ExecuteResponse
	if err := json.Unmarshal(reply, &resp); err != nil {
		return transportError("internal", err.Error(), elapsed)
	}
	return outcomeOf(&resp, elapsed)
}

func (r messagingRunner) run(c confCase) outcome {
	call := c.Call
	if c.ID == "request-over-limit-with-store" {
		return outcome{Outcome: "skipped", Reason: "the claim-check store is not part of this wave"}
	}
	if c.ID == "cancel-before-dispatch" {
		// Fill the plugin's prefetch so the cancelled request waits on the broker until after its cancel arrived: four
		// at-least-once calls (an idempotency key makes a sleep repeatable) hold their deliveries until they reply.
		done := make(chan struct{}, 4)
		for i := 0; i < 4; i++ {
			go func(i int) {
				defer func() { done <- struct{}{} }()
				_, _ = r.client.Call(context.Background(), conformance.PluginID, transport.MethodExecute,
					executeRequest(r.manifest, confCall{Method: "execute", Node: "sleep", Parameters: map[string]any{"ms": 400}}),
					transport.CallOptions{Timeout: 5 * time.Second, Delivery: transport.AtLeastOnce, IdempotencyKey: fmt.Sprintf("blocker-%d", i)})
			}(i)
		}
		time.Sleep(50 * time.Millisecond)
		out := r.invoke(transport.MethodExecute, json.RawMessage(rawExecuteBody(r.manifest, call)), call)
		for i := 0; i < 4; i++ {
			<-done
		}
		return out
	}
	return repeated(c, func() outcome {
		switch call.Method {
		case "execute":
			return r.invoke(transport.MethodExecute, json.RawMessage(rawExecuteBody(r.manifest, call)), call)
		case "health":
			return r.invoke(transport.MethodHealth, map[string]any{}, call)
		case "getManifest":
			return r.invoke(transport.MethodGetManifest, map[string]any{}, call)
		case "testCredentials":
			return r.invoke(transport.MethodTestCredentials, call.TestCredentials, call)
		case "loadOptions":
			return r.invoke(transport.MethodLoadOptions, map[string]any{"nodeType": conformance.PluginID + "." + call.Node, "method": call.LoadOptions.Method, "parameters": map[string]any{}}, call)
		}
		return outcome{Outcome: "skipped", Reason: call.Method + " is not part of this runner"}
	})
}

// ---------------------------------------------------------------------------
// MCP (2026-07-28 wire, Streamable HTTP at /mcp)
// ---------------------------------------------------------------------------

var mcpMeta = map[string]any{
	"io.modelcontextprotocol/protocolVersion":    "2026-07-28",
	"io.modelcontextprotocol/clientCapabilities": map[string]any{},
	"io.modelcontextprotocol/clientInfo":         map[string]any{"name": "conformance-runner", "version": "1"},
}

type mcpReply struct {
	Status int
	Result map[string]any
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	}
}

// mcpRequest is one 2026-07-28 JSON-RPC request with the per-request _meta envelope and the matching headers.
func mcpRequest(ctx context.Context, url, method string, params map[string]any, token, name, version string) (mcpReply, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	full := map[string]any{}
	for k, v := range params {
		full[k] = v
	}
	if version == "2026-07-28" {
		full["_meta"] = mcpMeta
	}
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": full})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Mcp-Protocol-Version", version)
	if version == "2026-07-28" {
		req.Header.Set("Mcp-Method", method)
		if name != "" {
			req.Header.Set("Mcp-Name", name)
		}
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return mcpReply{}, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	text := string(data)
	if strings.HasPrefix(text, "event:") || strings.HasPrefix(text, "data:") {
		for _, line := range strings.Split(text, "\n") {
			if strings.HasPrefix(line, "data:") {
				text = strings.TrimSpace(line[5:])
				break
			}
		}
	}
	out := mcpReply{Status: resp.StatusCode}
	if strings.TrimSpace(text) == "" {
		return out, nil
	}
	var envelope struct {
		Result map[string]any `json:"result"`
		Error  *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(text), &envelope); err != nil {
		return out, fmt.Errorf("mcp: %d %s: %w", resp.StatusCode, text, err)
	}
	out.Result, out.Error = envelope.Result, envelope.Error
	return out, nil
}

type mcpRunner struct {
	url      string
	manifest landflow.PluginManifest
}

func (mcpRunner) face() string { return "mcp" }

var unknownTool = regexp.MustCompile(`(?i)unknown tool`)

func (r mcpRunner) run(c confCase) outcome {
	return repeated(c, func() outcome {
		call := c.Call
		if call.Method != "execute" {
			return outcome{Outcome: "skipped", Reason: "MCP has no " + call.Method + "; tools/call only runs Execute"}
		}
		timers := newTimers(call)
		defer timers.stop()
		started := time.Now()
		if timers.why() == "expired" {
			return transportError("expired", "", 0)
		}
		req := executeRequest(r.manifest, call)
		var arguments any = req.Parameters
		for _, it := range call.Items {
			if _, ok := it["json"].(map[string]any); !ok {
				arguments = "not-an-object"
			}
		}
		reply, err := mcpRequest(timers.ctx, r.url, "tools/call", map[string]any{"name": call.Node, "arguments": arguments}, confMCPToken, call.Node, "2026-07-28")
		elapsed := time.Since(started)
		if err != nil {
			if why := timers.why(); why != "" {
				return transportError(why, err.Error(), elapsed)
			}
			return transportError("internal", err.Error(), elapsed)
		}
		if timers.isLate() {
			return transportError("expired", "", elapsed)
		}
		if reply.Error != nil {
			code := "bad_request"
			switch reply.Error.Code {
			case -32602:
				if unknownTool.MatchString(reply.Error.Message) {
					code = "not_found"
				}
			case -32603:
				code = "internal"
			}
			return transportError(code, reply.Error.Message, elapsed)
		}
		if reply.Result == nil {
			return transportError("internal", fmt.Sprintf("status %d without a result", reply.Status), elapsed)
		}
		if isErr, _ := reply.Result["isError"].(bool); isErr {
			var texts []string
			if content, ok := reply.Result["content"].([]any); ok {
				for _, part := range content {
					if m, ok := part.(map[string]any); ok {
						t, _ := m["text"].(string)
						texts = append(texts, t)
					}
				}
			}
			return outcome{Outcome: "node-error", ErrorMessage: strings.Join(texts, "\n"), Elapsed: elapsed}
		}
		var items []landflow.Item
		if sc, ok := reply.Result["structuredContent"].(map[string]any); ok {
			if list, ok := sc["items"].([]any); ok {
				for _, it := range list {
					j, _ := it.(map[string]any)
					items = append(items, landflow.Item{JSON: j})
				}
			}
		}
		return outcome{Outcome: "reply", Response: &landflow.ExecuteResponse{Outputs: [][]landflow.Item{items}}, Elapsed: elapsed}
	})
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

// outputsMatch: each listed item's JSON must be a subset of the real item's JSON, branch by branch.
func outputsMatch(expected [][]map[string]any, actual [][]landflow.Item) bool {
	if expected == nil {
		return true
	}
	if len(expected) != len(actual) {
		return false
	}
	for b := range expected {
		if len(expected[b]) != len(actual[b]) {
			return false
		}
		for i, item := range expected[b] {
			if !isSubset(item["json"], roundTripAny(actual[b][i].JSON)) {
				return false
			}
		}
	}
	return true
}

func roundTripAny(v any) any {
	data, _ := json.Marshal(v)
	var out any
	_ = json.Unmarshal(data, &out)
	return out
}

func isSubset(part, whole any) bool {
	if reflect.DeepEqual(part, whole) {
		return true
	}
	switch p := part.(type) {
	case map[string]any:
		w, ok := whole.(map[string]any)
		if !ok {
			return false
		}
		for k, v := range p {
			if !isSubset(v, w[k]) {
				return false
			}
		}
		return true
	case []any:
		w, ok := whole.([]any)
		if !ok || len(w) != len(p) {
			return false
		}
		for i := range p {
			if !isSubset(p[i], w[i]) {
				return false
			}
		}
		return true
	}
	return false
}

func assertCase(t *testing.T, r runner, c confCase, out outcome, ranCount int, hooks *conformance.Hooks) {
	t.Helper()
	e := c.Expect
	allowed := e.outcomes()
	found := false
	for _, o := range allowed {
		if o == out.Outcome {
			found = true
		}
	}
	if !found {
		t.Fatalf("%s: outcome %s (%s %s), want one of %v", c.ID, out.Outcome, out.Code, out.ErrorMessage, allowed)
	}
	if e.Code != "" && out.Outcome == "transport-error" && out.Code != e.Code {
		t.Errorf("%s: code %s, want %s (%s)", c.ID, out.Code, e.Code, out.ErrorMessage)
	}
	if e.Outputs != nil && out.Response != nil && !outputsMatch(e.Outputs, out.Response.Outputs) {
		t.Errorf("%s: outputs %v", c.ID, out.Response.Outputs)
	}
	if e.ErrorMessage != "" && !strings.Contains(out.ErrorMessage, e.ErrorMessage) {
		t.Errorf("%s: error message %q does not contain %q", c.ID, out.ErrorMessage, e.ErrorMessage)
	}
	if e.Ran != nil && (ranCount > 0) != *e.Ran {
		t.Errorf("%s: ran %d times, want ran=%v", c.ID, ranCount, *e.Ran)
	}
	if e.SignalAborted {
		if s := hooks.LastSleep(); s == nil || !s.Aborted() {
			t.Errorf("%s: the sleep did not see its signal", c.ID)
		}
	}
	if e.WithinMs != nil && out.Elapsed > time.Duration(*e.WithinMs)*time.Millisecond {
		t.Errorf("%s: took %v, want within %d ms", c.ID, out.Elapsed, *e.WithinMs)
	}
	if e.DeliveryMode != "" {
		if mr, ok := r.(messagingRunner); ok && mr.lastDelivery() != e.DeliveryMode {
			t.Errorf("%s: delivery mode %q, want %q", c.ID, mr.lastDelivery(), e.DeliveryMode)
		}
	}
	if e.Count != nil && out.Response != nil {
		got, _ := out.Response.Outputs[0][0].JSON["count"].(int)
		if got == 0 {
			if f, ok := out.Response.Outputs[0][0].JSON["count"].(float64); ok {
				got = int(f)
			}
		}
		if got != *e.Count {
			t.Errorf("%s: count %d, want %d", c.ID, got, *e.Count)
		}
	}
}

// ---------------------------------------------------------------------------
// The suites
// ---------------------------------------------------------------------------

func TestConformance(t *testing.T) {
	kit := conformanceKitDir(t)
	for _, k := range []string{"LANDFLOW_HTTP_PORT", "LANDFLOW_GRPC_PORT", "LANDFLOW_REGISTRY_URL", "LANDFLOW_ADVERTISE_HOST", "LANDFLOW_LISTEN_HOST", "LANDFLOW_TRANSPORTS", "LANDFLOW_MAX_CONCURRENCY", "LANDFLOW_MCP", "LANDFLOW_MCP_CREDENTIALS"} {
		t.Setenv(k, "")
	}
	t.Setenv("LANDFLOW_TRANSPORT_SECRET", confSecret)
	t.Setenv("LANDFLOW_TRANSPORT_SECRET_PREVIOUS", "")
	t.Setenv("LANDFLOW_REGISTRY_SECRET", "")
	t.Setenv("LANDFLOW_MCP_TOKEN", confMCPToken)

	hooks := &conformance.Hooks{}
	hooks.Reset()
	p := conformance.New(hooks)
	broker := memory.NewBroker(memory.Options{Configure: func(c *transport.Capabilities) { c.MaxMessageBytes = confMaxMsgSize }})
	cfg := transport.Config{ConnectionID: "conformance", Prefix: "landflow"}
	var seen []transport.DispatchContext
	binding := landflow.NewBrokerBinding(broker.Driver(cfg))
	binding.AnnounceInterval = 60 * time.Second
	binding.Observe = func(_ transport.Method, dc transport.DispatchContext) { seen = append(seen, dc) }

	// The host side first, so it sees the plugin's first announce on the registry channel.
	client, err := transport.StartClient(context.Background(), transport.ClientOptions{Driver: broker.Driver(cfg), Keyring: transport.MustKeyring(confSecret), NoRegistryProof: true, StatsInterval: -1, Log: transport.SilentLogger})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- landflow.Serve(ctx, p, landflow.WithHTTP(confHTTPPort), landflow.WithGRPC(confGRPCPort), landflow.WithBinding(binding), landflow.WithMaxConcurrency(4),
			landflow.WithRegistryURL("off"), landflow.WithLogger(log.New(io.Discard, "", 0)), landflow.WithMCP(landflow.MCPOptions{Token: confMCPToken}))
	}()
	defer func() {
		cancel()
		if err := <-done; err != nil {
			t.Errorf("serve: %v", err)
		}
	}()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if pl, ok := client.Plugin(conformance.PluginID); ok && len(pl.Instances) == 1 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if pl, ok := client.Plugin(conformance.PluginID); !ok || len(pl.Instances) != 1 {
		t.Fatal("the plugin never announced over the memory broker")
	}
	manifest := p.Manifest()

	conn, err := grpc.NewClient("127.0.0.1:"+strconv.Itoa(confGRPCPort), grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	runners := []runner{
		httpRunner{base: "http://127.0.0.1:" + strconv.Itoa(confHTTPPort), manifest: manifest},
		grpcRunner{client: pb.NewPluginServiceClient(conn), manifest: manifest},
		messagingRunner{client: client, broker: broker, manifest: manifest, hooks: hooks, seen: &seen},
		mcpRunner{url: "http://127.0.0.1:" + strconv.Itoa(confHTTPPort) + landflow.PathMCP, manifest: manifest},
	}
	for _, r := range runners {
		r := r
		t.Run(r.face(), func(t *testing.T) {
			for _, suite := range loadSuites(t, r.face()) {
				for _, c := range suite.Cases {
					c := c
					t.Run(suite.Suite+"/"+c.ID, func(t *testing.T) {
						hooks.Reset()
						seen = nil
						out := r.run(c)
						if out.Outcome == "skipped" {
							t.Skip(out.Reason)
						}
						// Give a late or dropped call time to show up before asserting it never ran (or that its signal fired).
						if (c.Expect.Ran != nil && !*c.Expect.Ran) || c.Expect.SignalAborted || c.ID == "late-reply-dropped" {
							time.Sleep(300 * time.Millisecond)
						}
						ran := hooks.Executions()
						if c.Call.Node != "" {
							ran = hooks.RunsOf(c.Call.Node)
						}
						assertCase(t, r, c, out, ran, hooks)
					})
				}
			}
		})
	}

	t.Run("mcp tool listing", func(t *testing.T) {
		url := "http://127.0.0.1:" + strconv.Itoa(confHTTPPort) + landflow.PathMCP
		defs, err := mcpface.ToolsFromManifest(manifest)
		if err != nil {
			t.Fatal(err)
		}
		var expected []any
		names := []string{}
		for _, d := range defs {
			expected = append(expected, roundTripAny(d.WithoutBinding()))
			names = append(names, d.Name)
		}
		if strings.Join(names, ",") != "echo,sleep,fail,payload,counter" {
			t.Fatalf("tools %v", names)
		}
		modern, err := mcpRequest(nil, url, "tools/list", map[string]any{}, confMCPToken, "", "2026-07-28")
		if err != nil || modern.Status != 200 || modern.Result["resultType"] != "complete" {
			t.Fatalf("modern tools/list: %+v %v", modern, err)
		}
		if !reflect.DeepEqual(modern.Result["tools"], expected) {
			g, _ := json.MarshalIndent(modern.Result["tools"], "", " ")
			e, _ := json.MarshalIndent(expected, "", " ")
			t.Fatalf("tools/list differs from the shared mapping\n%s\n--- want ---\n%s", g, e)
		}
		// 2025-11-25: the stateless legacy path (initialize, then tools/list).
		init, err := mcpRequest(nil, url, "initialize", map[string]any{"protocolVersion": "2025-11-25", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "x", "version": "0"}}, confMCPToken, "", "2025-11-25")
		if err != nil || init.Result["protocolVersion"] != "2025-11-25" {
			t.Fatalf("legacy initialize: %+v %v", init, err)
		}
		legacy, err := mcpRequest(nil, url, "tools/list", map[string]any{}, confMCPToken, "", "2025-11-25")
		if err != nil || !reflect.DeepEqual(legacy.Result["tools"], expected) {
			t.Fatalf("legacy tools/list: %+v %v", legacy, err)
		}
		// The well-known document lists the face.
		resp, err := http.Get("http://127.0.0.1:" + strconv.Itoa(confHTTPPort) + landflow.PathWellKnown)
		if err != nil {
			t.Fatal(err)
		}
		var doc landflow.WellKnownDocument
		_ = json.NewDecoder(resp.Body).Decode(&doc)
		resp.Body.Close()
		if doc.Endpoints.MCP != landflow.PathMCP {
			t.Fatalf("well-known endpoints %+v", doc.Endpoints)
		}
		// The server listens on loopback only, so no token is needed (the token rule itself is tested in mcpface and mcp_test.go).
		noToken, err := mcpRequest(nil, url, "tools/list", map[string]any{}, "", "", "2026-07-28")
		if err != nil || noToken.Status != 200 {
			t.Fatalf("no token on loopback: %+v %v", noToken, err)
		}
	})
	_ = kit
}
