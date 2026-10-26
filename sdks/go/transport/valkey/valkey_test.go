package valkey

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/landflow/landflow/sdks/go/transport"
)

// serverURL returns the URL under test or skips (LANDFLOW_TEST_VALKEY=redis://127.0.0.1:56379).
// The dev Valkey is shared with the running app: every key carries a unique prefix and is deleted.
func serverURL(t *testing.T) string {
	t.Helper()
	u := os.Getenv("LANDFLOW_TEST_VALKEY")
	if u == "" {
		t.Skip("set LANDFLOW_TEST_VALKEY=redis://127.0.0.1:56379 to run against Valkey")
	}
	return u
}

func randomPrefix() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return "landflow-test-" + hex.EncodeToString(b)
}

func connect(t *testing.T) (*Driver, transport.Names) {
	t.Helper()
	prefix := randomPrefix()
	// A short ClaimAfter so a requeue and a dead consumer's entries come back within the test.
	d := New(Config{Config: transport.Config{ConnectionID: "test", Prefix: prefix}, URL: serverURL(t), ClaimIdle: 500 * time.Millisecond, Block: 200 * time.Millisecond})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := d.Connect(ctx); err != nil {
		t.Skipf("Valkey not reachable: %v", err)
	}
	return d, transport.NewNames(prefix)
}

func TestConfigFromURL(t *testing.T) {
	cfg, err := ConfigFromURL("valkey-main", "valkey://127.0.0.1:56379/2", transport.ConnectionOptions{Password: "p", Prefix: "lf"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.URL != "redis://127.0.0.1:56379/2" || cfg.Password != "p" || cfg.Prefix != "lf" || !New(cfg).Capabilities().Headers {
		t.Errorf("config = %+v", cfg)
	}
	for _, bad := range []string{"", "kafka://x:1", "redis://[::1"} {
		if _, err := ConfigFromURL("c", bad, transport.ConnectionOptions{}); err == nil {
			t.Errorf("%q: want an error", bad)
		}
	}
	if f, ok := transport.LookupDriver("valkey"); !ok {
		t.Fatal("driver not registered")
	} else if drv, err := f("c", "redis://x:1", transport.ConnectionOptions{}); err != nil || drv.Kind() != Kind || drv.Capabilities().Replies != transport.RepliesChannel {
		t.Errorf("factory: %v", err)
	}
}

func TestRoundTrip(t *testing.T) {
	d, names := connect(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	request := names.Request("echo")
	t.Cleanup(func() {
		cctx, ccancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer ccancel()
		_ = d.DeleteStreams(cctx, request)
		_ = d.Close()
	})
	if err := d.Declare(ctx, []transport.ChannelSpec{transport.RequestSpec(request, 0)}); err != nil {
		t.Fatal(err)
	}
	if err := d.Declare(ctx, []transport.ChannelSpec{transport.RequestSpec(request, 0)}); err != nil {
		t.Fatalf("declare is not idempotent: %v", err)
	}
	// Buffered before any consumer attaches (binary mode: h:<header> fields and b).
	if out, err := d.Publish(ctx, request, transport.WireEvent{Headers: map[string]string{"content-type": "application/json", "ID": "ev-0"}, Body: []byte(`{"id":"ev-0"}`)}, transport.PublishOptions{}); err != nil || out != transport.Accepted {
		t.Fatalf("publish: %v %v", out, err)
	}
	if st, err := d.Stats(ctx, request); err != nil || st.Depth == nil || *st.Depth != 1 || st.Consumers == nil || *st.Consumers != 0 {
		t.Errorf("stats before consuming: %+v %v", st, err)
	}

	type seen struct {
		event   transport.WireEvent
		attempt int
	}
	var mu sync.Mutex
	var got []seen
	var requeued atomic.Bool
	var held = make(chan struct{})
	var subs []transport.Subscription
	for i := 0; i < 2; i++ {
		sub, err := d.Consume(ctx, request, transport.ConsumeOptions{Group: request, Prefetch: 2, AckMode: transport.AckManual}, func(ctx context.Context, event transport.WireEvent, del transport.Delivery) {
			body := string(event.Body)
			if body == `{"id":"ev-2"}` && requeued.CompareAndSwap(false, true) {
				_ = del.Nack(ctx, true)
				return
			}
			if body == `{"id":"ev-3"}` && del.Attempt() == 1 {
				// Hold the delivery and never ack: a "dead" consumer; it must be reclaimed by another.
				<-held
				return
			}
			mu.Lock()
			got = append(got, seen{event, del.Attempt()})
			mu.Unlock()
			_ = del.Ack(ctx)
		})
		if err != nil {
			t.Fatal(err)
		}
		subs = append(subs, sub)
	}
	for i := 1; i < 5; i++ {
		if _, err := d.Publish(ctx, request, transport.WireEvent{Headers: map[string]string{"content-type": "application/json", "id": fmt.Sprintf("ev-%d", i), "lfsig": "s"}, Body: []byte(fmt.Sprintf(`{"id":"ev-%d"}`, i))}, transport.PublishOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := len(got)
		mu.Unlock()
		if n == 5 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	close(held)
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 5 {
		t.Fatalf("got %d deliveries, want 5: %+v", len(got), got)
	}
	ids := map[string]int{}
	for _, s := range got {
		ids[string(s.event.Body)]++
		if s.event.Headers["content-type"] != "application/json" || s.event.Headers["id"] == "" || strings.Contains(fmt.Sprint(s.event.Headers), "h:") {
			t.Errorf("headers = %v", s.event.Headers)
		}
		want := 1
		if string(s.event.Body) == `{"id":"ev-2"}` || string(s.event.Body) == `{"id":"ev-3"}` {
			want = 2
		}
		if s.attempt != want {
			t.Errorf("attempt of %s = %d, want %d", s.event.Body, s.attempt, want)
		}
	}
	for i := 0; i < 5; i++ {
		if ids[fmt.Sprintf(`{"id":"ev-%d"}`, i)] != 1 {
			t.Errorf("ev-%d delivered %d times", i, ids[fmt.Sprintf(`{"id":"ev-%d"}`, i)])
		}
	}
	if st, err := d.Stats(ctx, request); err != nil || st.Consumers == nil || *st.Consumers != 2 {
		t.Errorf("stats while consuming: %+v %v", st, err)
	}
	for _, s := range subs {
		_ = s.Close(ctx)
	}
	// Everything consumed: no lag, no live consumers (the parking consumer does not count).
	if st, err := d.Stats(ctx, request); err != nil || st.Depth == nil || *st.Depth != 0 || *st.Consumers != 0 {
		t.Errorf("stats after acks: %+v %v", st, err)
	}
	// The raw entries use the TS layout: h:<header> and b.
	raw, err := d.client.Do(ctx, d.client.B().Xrange().Key(d.Key(request)).Start("-").End("+").Build()).AsXRange()
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range raw {
		if _, ok := e.FieldValues["b"]; !ok || e.FieldValues["h:content-type"] == "" {
			t.Errorf("entry fields = %v", e.FieldValues)
		}
	}
}

func TestBroadcast(t *testing.T) {
	d, names := connect(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	registry := names.Registry()
	t.Cleanup(func() {
		cctx, ccancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer ccancel()
		_ = d.DeleteStreams(cctx, registry)
		_ = d.Close()
	})
	if err := d.Declare(ctx, []transport.ChannelSpec{{Name: registry, Role: transport.RoleRegistry, Delivery: transport.DeliveryBroadcast, TTL: time.Minute}}); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Publish(ctx, registry, transport.WireEvent{Body: []byte("old")}, transport.PublishOptions{}); err != nil {
		t.Fatal(err)
	}
	var counts [2]atomic.Int32
	for i := 0; i < 2; i++ {
		i := i
		sub, err := d.Consume(ctx, registry, transport.ConsumeOptions{AckMode: transport.AckAuto}, func(ctx context.Context, event transport.WireEvent, del transport.Delivery) {
			if string(event.Body) == "new" {
				counts[i].Add(1)
			}
			_ = del.Ack(ctx)
		})
		if err != nil {
			t.Fatal(err)
		}
		defer sub.Close(ctx)
	}
	time.Sleep(300 * time.Millisecond) // the readers must be blocked on XREAD $ before the publish
	if _, err := d.Publish(ctx, registry, transport.WireEvent{Body: []byte("new")}, transport.PublishOptions{}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) && (counts[0].Load() < 1 || counts[1].Load() < 1) {
		time.Sleep(20 * time.Millisecond)
	}
	if counts[0].Load() != 1 || counts[1].Load() != 1 {
		t.Errorf("broadcast counts = %d %d, want 1 1 (the old entry must not be seen)", counts[0].Load(), counts[1].Load())
	}
}

func TestNotConnected(t *testing.T) {
	d := New(Config{URL: "redis://127.0.0.1:1"})
	if _, err := d.Publish(context.Background(), "x", transport.WireEvent{}, transport.PublishOptions{}); !transport.IsNotConnected(err) {
		t.Errorf("publish before connect: %v", err)
	}
	if err := d.Close(); err != nil {
		t.Error(err)
	}
	if err := d.Connect(context.Background()); !transport.IsNotConnected(err) {
		t.Errorf("connect after close: %v", err)
	}
}
