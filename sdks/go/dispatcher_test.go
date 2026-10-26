package landflow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "github.com/landflow/landflow/sdks/go/landflowpb"
)

// blockNode waits until its context ends or a release channel fires, so tests
// can hold calls in flight and watch deadlines reach node code.
type blockNode struct {
	mu      sync.Mutex
	release chan struct{}
	seen    []string // the transports the node saw
}

func (b *blockNode) Description() NodeDescriptor {
	return NodeDescriptor{Name: "block", DisplayName: "Block", Description: "Waits", Version: V(1)}
}

func (b *blockNode) Execute(ctx *ExecuteContext) ([][]Item, error) {
	b.mu.Lock()
	b.seen = append(b.seen, TransportOf(ctx))
	release := b.release
	b.mu.Unlock()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-release:
		return [][]Item{{{JSON: map[string]any{"ok": true}}}}, nil
	}
}

func blockPlugin() (*Plugin, *blockNode) {
	n := &blockNode{release: make(chan struct{})}
	return NewPlugin(PluginInfo{ID: "block-plugin", Name: "Block", Version: "1.0.0"}, n, upperNode{}), n
}

func TestDispatcherDeadlineReachesNode(t *testing.T) {
	p, _ := blockPlugin()
	d := NewDispatcher(p, DispatcherOptions{})
	start := time.Now()
	resp, err := d.Execute(context.Background(), execReq("block-plugin.block", nil, map[string]any{}), CallOptions{Deadline: time.Now().Add(50 * time.Millisecond)})
	if err != nil {
		t.Fatal(err)
	}
	if resp.Error == nil || !strings.Contains(resp.Error.Message, "deadline exceeded") {
		t.Errorf("node should report the deadline: %+v", resp.Error)
	}
	if time.Since(start) > 2*time.Second {
		t.Error("deadline did not cut the call short")
	}
	if d.InFlight() != 0 {
		t.Errorf("in flight after the call = %d", d.InFlight())
	}
}

func TestDispatcherCancelReachesNode(t *testing.T) {
	p, _ := blockPlugin()
	d := NewDispatcher(p, DispatcherOptions{})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan *ExecuteResponse, 1)
	go func() {
		resp, _ := d.Execute(ctx, execReq("block-plugin.block", nil, map[string]any{}), CallOptions{Transport: "fake"})
		done <- resp
	}()
	waitFor(t, "call in flight", func() bool { return d.InFlight() == 1 })
	cancel()
	select {
	case resp := <-done:
		if resp.Error == nil || !strings.Contains(resp.Error.Message, "canceled") {
			t.Errorf("node should report the cancellation: %+v", resp.Error)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancel did not reach the node")
	}
	// A context that is already done never starts the node.
	if _, err := d.Execute(ctx, execReq("block-plugin.block", nil), CallOptions{}); !errors.Is(err, context.Canceled) {
		t.Errorf("expired context: err = %v", err)
	}
}

func TestDispatcherConcurrencyLimit(t *testing.T) {
	p, node := blockPlugin()
	d := NewDispatcher(p, DispatcherOptions{MaxConcurrency: 2})
	if d.MaxConcurrency() != 2 {
		t.Fatalf("MaxConcurrency = %d", d.MaxConcurrency())
	}
	results := make(chan error, 3)
	for i := 0; i < 2; i++ {
		go func() {
			_, err := d.Execute(context.Background(), execReq("block-plugin.block", nil, map[string]any{}), CallOptions{Transport: "http"})
			results <- err
		}()
	}
	waitFor(t, "two calls in flight", func() bool { return d.InFlight() == 2 })

	// The third waits for a slot (the queue holds MaxConcurrency by default) and gives up at its deadline
	// with the context's error: it never ran, but it did wait, so it is not a capacity refusal.
	_, err := d.Execute(context.Background(), execReq("block-plugin.block", nil, map[string]any{}), CallOptions{Deadline: time.Now().Add(100 * time.Millisecond)})
	if !errors.Is(err, context.DeadlineExceeded) || errors.Is(err, ErrOverloaded) {
		t.Errorf("third call: err = %v, want DeadlineExceeded without ErrOverloaded", err)
	}
	if d.InFlight() != 2 || d.Waiting() != 0 {
		t.Errorf("in flight = %d waiting = %d", d.InFlight(), d.Waiting())
	}

	// A fourth waits, and runs once a slot frees up.
	go func() {
		_, err := d.Execute(context.Background(), execReq("block-plugin.block", nil, map[string]any{}), CallOptions{})
		results <- err
	}()
	waitFor(t, "fourth call waiting", func() bool { return d.Waiting() == 1 })
	close(node.release)
	for i := 0; i < 3; i++ {
		select {
		case err := <-results:
			if err != nil {
				t.Errorf("call failed: %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("calls did not finish")
		}
	}
	if d.InFlight() != 0 {
		t.Errorf("in flight after all calls = %d", d.InFlight())
	}
	node.mu.Lock()
	defer node.mu.Unlock()
	if len(node.seen) != 3 || node.seen[0] != "http" {
		t.Errorf("transports seen by the node = %v", node.seen)
	}
}

func TestDispatcherStatusMapping(t *testing.T) {
	p, node := blockPlugin()
	d := NewDispatcher(p, DispatcherOptions{MaxConcurrency: 1})
	p.dispatcher.Store(d)
	srv := httptest.NewServer(p.Handler())
	defer srv.Close()

	// Fill the only slot.
	go func() {
		_, _ = d.Execute(context.Background(), execReq("block-plugin.block", nil, map[string]any{}), CallOptions{})
	}()
	waitFor(t, "slot taken", func() bool { return d.InFlight() == 1 })

	// HTTP: a waiter whose x-landflow-deadline passes is 504; one refused at once (queue full) is 429 + Retry-After.
	body, _ := json.Marshal(execReq("block-plugin.upper", map[string]any{}, map[string]any{"value": "x"}))
	req, _ := http.NewRequest(http.MethodPost, srv.URL+PathExecute, strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(DeadlineHeader, strconv.FormatInt(time.Now().Add(100*time.Millisecond).UnixMilli(), 10))
	res, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusGatewayTimeout {
		t.Errorf("deadline while waiting: status = %d, want 504", res.StatusCode)
	}
	// Fill the queue (MaxQueue defaults to MaxConcurrency = 1), then the next call is refused at once.
	waiterCtx, stopWaiter := context.WithCancel(context.Background())
	defer stopWaiter()
	go func() {
		_, _ = d.Execute(waiterCtx, execReq("block-plugin.upper", map[string]any{}, map[string]any{"value": "x"}), CallOptions{})
	}()
	waitFor(t, "one waiter", func() bool { return d.Waiting() == 1 })
	start := time.Now()
	code, ex := doJSON(t, srv, http.MethodPost, PathExecute, string(body))
	if code != http.StatusTooManyRequests {
		t.Errorf("queue full: status = %d %v, want 429", code, ex)
	}
	if time.Since(start) > time.Second {
		t.Error("a capacity refusal must not wait")
	}
	res2, _ := http.Post(srv.URL+PathExecute, "application/json", strings.NewReader(string(body)))
	if res2.Header.Get("Retry-After") != "1" || res2.StatusCode != http.StatusTooManyRequests {
		t.Errorf("capacity refusal: status %d Retry-After %q", res2.StatusCode, res2.Header.Get("Retry-After"))
	}
	res2.Body.Close()
	// gRPC: the same refusal is ResourceExhausted, at once.
	client := bufconnClient(t, p)
	msg, _ := ExecuteRequestToProto(execReq("block-plugin.upper", map[string]any{}, map[string]any{"value": "x"}))
	if _, err := client.Execute(context.Background(), msg); status.Code(err) != codes.ResourceExhausted {
		t.Errorf("gRPC queue full: code = %v (%v), want ResourceExhausted", status.Code(err), err)
	}
	// gRPC: a waiter whose deadline passes is DeadlineExceeded; a cancelled one Canceled (the client sees its own
	// cancellation; the server-side mapping is checked directly below).
	stopWaiter()
	waitFor(t, "waiter gone", func() bool { return d.Waiting() == 0 })
	gctx, gcancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer gcancel()
	if _, err := client.Execute(gctx, msg); status.Code(err) != codes.DeadlineExceeded {
		t.Errorf("gRPC deadline while waiting: code = %v (%v)", status.Code(err), err)
	}
	if status.Code(grpcStatus(ErrOverloaded)) != codes.ResourceExhausted || status.Code(grpcStatus(context.Canceled)) != codes.Canceled {
		t.Error("ErrOverloaded must map to ResourceExhausted and context.Canceled to Canceled")
	}
	if statusFor(ErrOverloaded) != http.StatusTooManyRequests || statusFor(context.DeadlineExceeded) != http.StatusGatewayTimeout || statusFor(context.Canceled) != StatusClientClosedRequest {
		t.Error("HTTP status mapping of ErrOverloaded / DeadlineExceeded / Canceled")
	}
	// HTTP: a client that goes away while waiting is 499 on the server side (the client sees nothing).
	cctx, ccancel := context.WithCancel(context.Background())
	creq, _ := http.NewRequestWithContext(cctx, http.MethodPost, srv.URL+PathExecute, strings.NewReader(string(body)))
	creq.Header.Set("Content-Type", "application/json")
	go func() { waitFor(t, "http waiter", func() bool { return d.Waiting() == 1 }); ccancel() }()
	if _, err := srv.Client().Do(creq); err == nil {
		t.Error("expected the cancelled request to fail client-side")
	}
	waitFor(t, "cancelled waiter gone", func() bool { return d.Waiting() == 0 })
	close(node.release)
	waitFor(t, "slot released", func() bool { return d.InFlight() == 0 })
	// The HTTP binding reports its kind on the span and to the node.
	code, ex = doJSON(t, srv, http.MethodPost, PathExecute, string(body))
	if code != 200 || ex["error"] != nil {
		t.Errorf("execute after release: %d %v", code, ex)
	}
}

func TestPluginDispatcherIsShared(t *testing.T) {
	p := testPlugin()
	if p.Dispatcher() != p.Dispatcher() || p.Dispatcher().Plugin() != p {
		t.Error("Plugin.Dispatcher must return one dispatcher")
	}
	var _ pb.PluginServiceServer = &grpcService{}
}

// TestDispatcherQueueLimit: the queue is bounded (default MaxConcurrency, NoQueue = none), refusals are immediate and
// never run the node, waiters run in arrival order, and cancelling a waiter frees its place.
func TestDispatcherQueueLimit(t *testing.T) {
	p, node := blockPlugin()
	d := NewDispatcher(p, DispatcherOptions{MaxConcurrency: 1, MaxQueue: 2})
	if d.MaxQueue() != 2 || NewDispatcher(p, DispatcherOptions{MaxConcurrency: 3}).MaxQueue() != 3 || NewDispatcher(p, DispatcherOptions{MaxConcurrency: 3, MaxQueue: NoQueue}).MaxQueue() != 0 {
		t.Fatalf("MaxQueue defaults: %d", d.MaxQueue())
	}
	results := make(chan string, 8)
	run := func(ctx context.Context, name string) {
		_, err := d.Execute(ctx, execReq("block-plugin.block", nil, map[string]any{"name": name}), CallOptions{Transport: name})
		if err != nil {
			results <- name + ":" + err.Error()
		} else {
			results <- name
		}
	}
	go run(context.Background(), "first")
	waitFor(t, "first in flight", func() bool { return d.InFlight() == 1 })
	go run(context.Background(), "second")
	waitFor(t, "second waiting", func() bool { return d.Waiting() == 1 })
	cancelCtx, cancel := context.WithCancel(context.Background())
	go run(cancelCtx, "third")
	waitFor(t, "third waiting", func() bool { return d.Waiting() == 2 })

	// Queue full: refused at once, the node never sees it.
	start := time.Now()
	_, err := d.Execute(context.Background(), execReq("block-plugin.block", nil, map[string]any{}), CallOptions{})
	if !errors.Is(err, ErrOverloaded) || time.Since(start) > time.Second {
		t.Errorf("fourth: err = %v after %v, want ErrOverloaded at once", err, time.Since(start))
	}
	// A cancelled waiter leaves with context.Canceled and frees its place.
	cancel()
	select {
	case got := <-results:
		if !strings.HasPrefix(got, "third:") || !strings.Contains(got, context.Canceled.Error()) {
			t.Errorf("third: %s", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancelled waiter did not return")
	}
	waitFor(t, "place freed", func() bool { return d.Waiting() == 1 })
	go run(context.Background(), "fourth")
	waitFor(t, "fourth waiting", func() bool { return d.Waiting() == 2 })

	// Release: first finishes, second then fourth run in arrival order (block returns at once once released).
	close(node.release)
	var order []string
	for i := 0; i < 3; i++ {
		select {
		case got := <-results:
			order = append(order, got)
		case <-time.After(5 * time.Second):
			t.Fatalf("calls did not finish: %v", order)
		}
	}
	if strings.Join(order, ",") != "first,second,fourth" {
		t.Errorf("order = %v", order)
	}
	if d.InFlight() != 0 || d.Waiting() != 0 {
		t.Errorf("in flight = %d waiting = %d", d.InFlight(), d.Waiting())
	}
	node.mu.Lock()
	defer node.mu.Unlock()
	if len(node.seen) != 3 {
		t.Errorf("the node ran %d times (%v), want 3", len(node.seen), node.seen)
	}
	// NoQueue: no waiting at all.
	hold, unhold := context.WithCancel(context.Background())
	defer unhold()
	p2, n2 := blockPlugin()
	d2 := NewDispatcher(p2, DispatcherOptions{MaxConcurrency: 1, MaxQueue: NoQueue})
	go func() { _, _ = d2.Execute(hold, execReq("block-plugin.block", nil, map[string]any{}), CallOptions{}) }()
	waitFor(t, "d2 slot taken", func() bool { return d2.InFlight() == 1 })
	if _, err := d2.Execute(context.Background(), execReq("block-plugin.block", nil, map[string]any{}), CallOptions{}); !errors.Is(err, ErrOverloaded) {
		t.Errorf("NoQueue: err = %v", err)
	}
	close(n2.release)
}

// TestDispatcherWaitSkipsQueueLimit: a call with Wait (a broker face, already bounded by its prefetch) queues past
// MaxQueue instead of being refused, and runs once a slot frees; a call without it is still refused.
func TestDispatcherWaitSkipsQueueLimit(t *testing.T) {
	p, node := blockPlugin()
	d := NewDispatcher(p, DispatcherOptions{MaxConcurrency: 1, MaxQueue: NoQueue})
	done := make(chan error, 3)
	go func() {
		_, err := d.Execute(context.Background(), execReq("block-plugin.block", nil, map[string]any{}), CallOptions{Transport: "grpc"})
		done <- err
	}()
	waitFor(t, "slot taken", func() bool { return d.InFlight() == 1 })
	for i := 0; i < 2; i++ {
		go func() {
			_, err := d.Execute(context.Background(), execReq("block-plugin.block", nil, map[string]any{}), CallOptions{Transport: "kafka", Wait: true})
			done <- err
		}()
	}
	waitFor(t, "brokered calls waiting", func() bool { return d.Waiting() == 2 })
	if _, err := d.Execute(context.Background(), execReq("block-plugin.block", nil, map[string]any{}), CallOptions{Transport: "grpc"}); !errors.Is(err, ErrOverloaded) {
		t.Errorf("direct call past the queue: err = %v, want ErrOverloaded", err)
	}
	close(node.release)
	for i := 0; i < 3; i++ {
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("call %d: %v", i, err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("calls did not finish")
		}
	}
}

// TestHTTPDeadlineHeader: x-landflow-deadline (epoch ms) bounds the call; the node sees it; an expired one never runs.
func TestHTTPDeadlineHeader(t *testing.T) {
	p, node := blockPlugin()
	defer close(node.release)
	srv := httptest.NewServer(p.Handler())
	defer srv.Close()
	body, _ := json.Marshal(execReq("block-plugin.block", nil, map[string]any{}))
	post := func(deadline string) (*http.Response, map[string]any) {
		req, _ := http.NewRequest(http.MethodPost, srv.URL+PathExecute, strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		if deadline != "" {
			req.Header.Set(DeadlineHeader, deadline)
		}
		res, err := srv.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(res.Body).Decode(&out)
		return res, out
	}
	start := time.Now()
	res, out := post(strconv.FormatInt(time.Now().Add(100*time.Millisecond).UnixMilli(), 10))
	if msg, _ := out["error"].(map[string]any); res.StatusCode != 200 || msg == nil || !strings.Contains(fmt.Sprint(msg["message"]), "deadline") {
		t.Errorf("deadline in flight: %d %v", res.StatusCode, out)
	}
	if time.Since(start) > 2*time.Second {
		t.Error("the header's deadline did not cut the call short")
	}
	if res, _ := post(strconv.FormatInt(time.Now().Add(-time.Second).UnixMilli(), 10)); res.StatusCode != http.StatusGatewayTimeout {
		t.Errorf("expired deadline: status = %d, want 504", res.StatusCode)
	}
	// Garbage is ignored: the call runs (and is released by the test's deferred close through a fresh request).
	if opts := httpCall(&http.Request{Header: http.Header{"X-Landflow-Deadline": {"soon"}}}); !opts.Deadline.IsZero() || opts.Transport != "http" {
		t.Errorf("unparsable header: %+v", opts)
	}
	if opts := httpCall(&http.Request{Header: http.Header{"X-Landflow-Deadline": {"1700000000000"}}}); opts.Deadline.UnixMilli() != 1700000000000 {
		t.Errorf("header parsed as %v", opts.Deadline)
	}
}
