package kit

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/landflow/landflow/sdks/go/transport"
)

// DefaultDeadline is the runner's deadline when a case gives none (the TS runner's 3 s: the plugin's nodes answer in
// milliseconds and the tampered-event cases are only resolved by the deadline).
const DefaultDeadline = 3 * time.Second

// Options configures one run of the kit over a transport.Client.
type Options struct {
	Client *transport.Client
	Hooks  Hooks
	// LastDelivery is the delivery mode the plugin-side core chose for the last dispatched call (the bridge's
	// Observe hook); nil skips the deliveryMode assertions.
	LastDelivery func() (transport.DeliveryMode, bool)
	// Tap alters events in flight (the memory broker's Tap); nil skips the tampered-event cases.
	Tap func(fn func(channel string, event transport.WireEvent) (transport.WireEvent, bool)) func()
	// Manifest decides delivery modes like the host: at least once for an Execute of an idempotent node.
	Manifest json.RawMessage
	// Skip maps a case id to the reason it is skipped.
	Skip map[string]string
	// Settle is how long to wait before asserting that a call never ran (default 300 ms; raise for slow brokers).
	Settle time.Duration
}

// Outcome is what one case produced.
type Outcome struct {
	Outcome      string
	Code         string
	Response     map[string]any
	ErrorMessage string
	Elapsed      time.Duration
}

// Run runs every messaging case as a subtest.
func Run(t *testing.T, opts Options) {
	t.Helper()
	suites, err := LoadSuites()
	if err != nil {
		t.Fatal(err)
	}
	if opts.Settle <= 0 {
		opts.Settle = 300 * time.Millisecond
	}
	r := &runner{opts: opts, isIdempotent: transport.IdempotencyFromManifest(opts.Manifest), names: opts.Client.Names}
	for _, suite := range suites {
		for _, c := range suite.Cases {
			c := c
			t.Run(suite.Suite+"/"+c.ID, func(t *testing.T) {
				if reason, ok := opts.Skip[c.ID]; ok {
					t.Skip(reason)
				}
				if c.Call.Tamper != "" && c.Call.Tamper != "manifestHash" && opts.Tap == nil {
					t.Skip("the broker has no tap to tamper with events in flight")
				}
				opts.Hooks.Reset()
				outcome := r.run(t, c)
				if (c.Expect.Ran != nil && !*c.Expect.Ran) || c.Expect.SignalAborted || c.ID == "late-reply-dropped" {
					time.Sleep(opts.Settle)
				}
				r.assert(t, c, outcome)
			})
		}
	}
}

type runner struct {
	opts         Options
	isIdempotent func(json.RawMessage) bool
	names        transport.Names
}

func (r *runner) executeRequest(call Call) map[string]any {
	items := call.Items
	if items == nil {
		items = []map[string]any{{"json": map[string]any{}}}
	}
	params := map[string]any{}
	for k, v := range call.Parameters {
		params[k] = v
	}
	if call.PadBytes > 0 {
		params["message"] = strings.Repeat("x", call.PadBytes)
	}
	itemParams := make([]map[string]any, len(items))
	for i := range itemParams {
		itemParams[i] = map[string]any{}
	}
	req := map[string]any{
		"protocol": transport.ProtocolVersion, "executionId": "ex_" + call.Node, "mode": "manual",
		"node":       map[string]any{"id": "n-" + call.Node, "name": call.Node, "type": PluginID + "." + call.Node, "typeVersion": 1},
		"parameters": params, "itemParameters": itemParams, "inputs": []any{items},
	}
	if call.IdempotencyKey != "" {
		req["idempotencyKey"] = call.IdempotencyKey
	}
	if call.Credentials != nil {
		req["credentials"] = call.Credentials
	}
	return req
}

func (r *runner) run(t *testing.T, c Case) Outcome {
	t.Helper()
	call := c.Call
	if c.ID == "cancel-before-dispatch" {
		// Fill the plugin's prefetch (4) so the cancelled request waits on the broker until after its cancel arrived:
		// four at-least-once calls (an idempotency key makes a sleep repeatable) hold their deliveries until they reply.
		done := make(chan struct{}, 4)
		for i := 0; i < 4; i++ {
			go func(i int) {
				defer func() { done <- struct{}{} }()
				body := r.executeRequest(Call{Method: "execute", Node: "sleep", Parameters: map[string]any{"ms": 400}})
				_, _ = r.opts.Client.Call(context.Background(), PluginID, transport.MethodExecute, body, transport.CallOptions{
					Timeout: 5 * time.Second, Delivery: transport.AtLeastOnce, IdempotencyKey: fmt.Sprintf("blocker-%d", i),
				})
			}(i)
		}
		time.Sleep(50 * time.Millisecond)
		outcome := r.invoke(transport.MethodExecute, r.executeRequest(call), call)
		for i := 0; i < 4; i++ {
			<-done
		}
		return outcome
	}
	repeat := call.Repeat
	if repeat <= 0 {
		repeat = 1
	}
	var last Outcome
	for i := 0; i < repeat; i++ {
		switch call.Method {
		case "execute":
			last = r.invoke(transport.MethodExecute, r.executeRequest(call), call)
		case "health":
			last = r.invoke(transport.MethodHealth, map[string]any{}, call)
		case "getManifest":
			last = r.invoke(transport.MethodGetManifest, map[string]any{}, call)
		case "testCredentials":
			last = r.invoke(transport.MethodTestCredentials, call.TestCredentials, call)
		case "loadOptions":
			method := ""
			if call.LoadOptions != nil {
				method = call.LoadOptions.Method
			}
			last = r.invoke(transport.MethodLoadOptions, map[string]any{"nodeType": PluginID + "." + call.Node, "method": method, "parameters": map[string]any{}}, call)
		default:
			t.Skipf("%s is not part of this runner", call.Method)
		}
	}
	return last
}

func (r *runner) invoke(method transport.Method, body any, call Call) Outcome {
	deadlineMs := int(DefaultDeadline / time.Millisecond)
	if call.DeadlineMs != nil {
		deadlineMs = *call.DeadlineMs
	}
	deadline := time.Now().Add(time.Duration(deadlineMs) * time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cancelled := false
	if call.CancelAfterMs != nil {
		// cancelAfterMs is relative to the moment the call is sent: 0 means "as soon as it is published", so the cancel
		// goes out on the control channel instead of aborting before the publish.
		after := max(time.Duration(*call.CancelAfterMs)*time.Millisecond, 10*time.Millisecond)
		timer := time.AfterFunc(after, func() { cancelled = true; cancel() })
		defer timer.Stop()
	}
	untap := r.tamper(call.Tamper)
	defer untap()
	delivery := transport.AtLeastOnce
	if method == transport.MethodExecute {
		raw, _ := json.Marshal(body)
		if !r.isIdempotent(raw) {
			delivery = transport.AtMostOnce
		}
	}
	co := transport.CallOptions{Deadline: deadline, IdempotencyKey: call.IdempotencyKey, Delivery: delivery}
	if call.Tamper == "manifestHash" {
		co.ManifestHash = "ffffffffffffffff"
	}
	started := time.Now()
	reply, err := r.opts.Client.Call(ctx, PluginID, method, body, co)
	elapsed := time.Since(started)
	if err == nil {
		out := Outcome{Outcome: "reply", Elapsed: elapsed}
		if method == transport.MethodExecute {
			var resp map[string]any
			_ = json.Unmarshal(reply, &resp)
			out.Response = resp
			if e, ok := resp["error"].(map[string]any); ok && e != nil {
				out.Outcome = "node-error"
				out.ErrorMessage, _ = e["message"].(string)
			}
		}
		return out
	}
	out := Outcome{Outcome: "transport-error", ErrorMessage: err.Error(), Elapsed: elapsed}
	var (
		timeout   *transport.TimeoutError
		cancelErr *transport.CancelledError
		undeliv   *transport.UndeliverableError
		mismatch  *transport.ManifestMismatchError
		remote    *transport.RemoteError
	)
	switch {
	case time.Now().After(deadline) && !cancelled, errors.As(err, &timeout):
		out.Code = "expired"
	case errors.As(err, &cancelErr):
		out.Code = "cancelled"
	case errors.As(err, &undeliv):
		out.Code = string(undeliv.Reason)
	case errors.As(err, &mismatch):
		out.Code = "manifest_mismatch"
	case errors.As(err, &remote):
		out.Code = string(remote.RemoteCode)
	default:
		out.Code = "unknown: " + err.Error()
	}
	return out
}

// tamper breaks requests on the wire for the bad-signature / bad-ciphertext cases.
func (r *runner) tamper(kind string) func() {
	if kind == "" || kind == "manifestHash" || r.opts.Tap == nil {
		return func() {}
	}
	request := r.names.Request(PluginID)
	return r.opts.Tap(func(channel string, event transport.WireEvent) (transport.WireEvent, bool) {
		if channel != request {
			return event, true
		}
		headers := map[string]string{}
		for k, v := range event.Headers {
			headers[k] = v
		}
		body := append([]byte(nil), event.Body...)
		if kind == "signature" {
			if sig, ok := headers["lfsig"]; ok && len(sig) > 0 {
				first := "0"
				if sig[0] == '0' {
					first = "1"
				}
				headers["lfsig"] = first + sig[1:]
			}
		} else if len(body) > 0 {
			body[len(body)-1] ^= 0xff
		}
		return transport.WireEvent{Headers: headers, Body: body}, true
	})
}

func (r *runner) assert(t *testing.T, c Case, outcome Outcome) {
	t.Helper()
	exp := c.Expect
	outcomes := exp.Outcomes()
	found := false
	for _, o := range outcomes {
		if o == outcome.Outcome {
			found = true
		}
	}
	if !found {
		t.Fatalf("%s: outcome %s (%s %s), want one of %v", c.ID, outcome.Outcome, outcome.Code, outcome.ErrorMessage, outcomes)
	}
	if exp.Code != "" && outcome.Outcome == "transport-error" && outcome.Code != exp.Code {
		t.Fatalf("%s: code %s (%s), want %s", c.ID, outcome.Code, outcome.ErrorMessage, exp.Code)
	}
	if exp.Outputs != nil && outcome.Response != nil {
		actual := outputsOf(outcome.Response)
		if !OutputsMatch(exp.Outputs, actual) {
			t.Fatalf("%s: outputs %v, want %v", c.ID, actual, exp.Outputs)
		}
	}
	if exp.ErrorMessage != "" && !strings.Contains(outcome.ErrorMessage, exp.ErrorMessage) {
		t.Fatalf("%s: error message %q does not contain %q", c.ID, outcome.ErrorMessage, exp.ErrorMessage)
	}
	ranCount := r.opts.Hooks.Executions()
	if c.Call.Node != "" {
		ranCount = r.opts.Hooks.ByNode(c.Call.Node)
	}
	if exp.Ran != nil && (ranCount > 0) != *exp.Ran {
		t.Fatalf("%s: ran %d times, want ran=%v", c.ID, ranCount, *exp.Ran)
	}
	if exp.SignalAborted {
		aborted, ok := r.opts.Hooks.LastSleepAborted()
		if !ok || !aborted {
			t.Fatalf("%s: the node did not see its cancellation (sleep ran: %v)", c.ID, ok)
		}
	}
	if exp.WithinMs != nil && outcome.Elapsed > time.Duration(*exp.WithinMs)*time.Millisecond {
		t.Fatalf("%s: took %s, want within %d ms", c.ID, outcome.Elapsed, *exp.WithinMs)
	}
	if exp.DeliveryMode != "" && r.opts.LastDelivery != nil {
		mode, ok := r.opts.LastDelivery()
		if !ok || string(mode) != exp.DeliveryMode {
			t.Fatalf("%s: delivery mode %q (seen %v), want %s", c.ID, mode, ok, exp.DeliveryMode)
		}
	}
	if exp.Count != nil && outcome.Response != nil {
		actual := outputsOf(outcome.Response)
		var count any
		if len(actual) > 0 && len(actual[0]) > 0 {
			if j, ok := actual[0][0]["json"].(map[string]any); ok {
				count = j["count"]
			}
		}
		if f, ok := count.(float64); !ok || f != *exp.Count {
			t.Fatalf("%s: count %v, want %v", c.ID, count, *exp.Count)
		}
	}
}

func outputsOf(resp map[string]any) [][]map[string]any {
	raw, _ := resp["outputs"].([]any)
	out := make([][]map[string]any, 0, len(raw))
	for _, branch := range raw {
		items, _ := branch.([]any)
		var b []map[string]any
		for _, it := range items {
			m, _ := it.(map[string]any)
			b = append(b, m)
		}
		out = append(out, b)
	}
	return out
}
