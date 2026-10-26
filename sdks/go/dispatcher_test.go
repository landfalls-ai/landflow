package landflow

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
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

	// The third waits for a slot and gives up at its deadline.
	_, err := d.Execute(context.Background(), execReq("block-plugin.block", nil, map[string]any{}), CallOptions{Deadline: time.Now().Add(100 * time.Millisecond)})
	if !errors.Is(err, ErrOverloaded) || !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("third call: err = %v, want ErrOverloaded wrapping DeadlineExceeded", err)
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

	// HTTP: a request whose client gives up while waiting for a slot is 503.
	body, _ := json.Marshal(execReq("block-plugin.upper", map[string]any{}, map[string]any{"value": "x"}))
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, srv.URL+PathExecute, strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	if _, err := srv.Client().Do(req); err == nil {
		t.Error("expected the client timeout to end the request")
	}
	// gRPC: the same wait ends with ResourceExhausted when the call's deadline passes.
	client := bufconnClient(t, p)
	gctx, gcancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer gcancel()
	msg, _ := ExecuteRequestToProto(execReq("block-plugin.upper", map[string]any{}, map[string]any{"value": "x"}))
	_, err := client.Execute(gctx, msg)
	if code := status.Code(err); code != codes.ResourceExhausted && code != codes.DeadlineExceeded {
		t.Errorf("gRPC at the limit: code = %v (%v)", code, err)
	}
	if grpcStatus(ErrOverloaded) == nil || status.Code(grpcStatus(ErrOverloaded)) != codes.ResourceExhausted {
		t.Error("ErrOverloaded must map to ResourceExhausted")
	}
	if statusFor(ErrOverloaded) != http.StatusServiceUnavailable || statusFor(context.DeadlineExceeded) != http.StatusGatewayTimeout {
		t.Error("HTTP status mapping of ErrOverloaded / DeadlineExceeded")
	}
	close(node.release)
	waitFor(t, "slot released", func() bool { return d.InFlight() == 0 })
	// The HTTP binding reports its kind on the span and to the node.
	code, ex := doJSON(t, srv, http.MethodPost, PathExecute, string(body))
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
