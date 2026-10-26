package amqp

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/landflow/landflow/sdks/go/transport"
)

// brokerURL returns the URL under test or skips (LANDFLOW_TEST_AMQP=amqp://user:pass@127.0.0.1:55672).
func brokerURL(t *testing.T) string {
	t.Helper()
	u := os.Getenv("LANDFLOW_TEST_AMQP")
	if u == "" {
		t.Skip("set LANDFLOW_TEST_AMQP=amqp://user:pass@127.0.0.1:55672 to run against RabbitMQ")
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
	d := New(Config{Config: transport.Config{ConnectionID: "test", Prefix: prefix}, URL: brokerURL(t)})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := d.Connect(ctx); err != nil {
		t.Skipf("RabbitMQ not reachable: %v", err)
	}
	return d, transport.NewNames(prefix)
}

func TestConfigFromURL(t *testing.T) {
	cfg, err := ConfigFromURL("rabbit", "amqp://127.0.0.1:55672/vh", transport.ConnectionOptions{Username: "u", Password: "p", TLS: true, Fields: map[string]string{"queue_type": "classic"}})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.URL != "amqps://u:p@127.0.0.1:55672/vh" || cfg.QueueType != "classic" || cfg.ConnectionID != "rabbit" {
		t.Errorf("config = %+v", cfg)
	}
	if New(cfg).AMQPConfig().Prefix != transport.DefaultPrefix {
		t.Error("default prefix")
	}
	for _, bad := range []string{"", "kafka://x:1", "amqp://x:1?x", "amqp:///"} {
		if _, err := ConfigFromURL("c", bad, transport.ConnectionOptions{}); err == nil && bad != "amqp://x:1?x" {
			t.Errorf("%q: want an error", bad)
		}
	}
	if _, err := ConfigFromURL("c", "amqp://x:1", transport.ConnectionOptions{Fields: map[string]string{"queue_type": "lazy"}}); err == nil {
		t.Error("bad queue_type accepted")
	}
	f, ok := transport.LookupDriver("amqp")
	if !ok {
		t.Fatal("driver not registered")
	}
	if drv, err := f("c", "amqp://x:1", transport.ConnectionOptions{}); err != nil || drv.Kind() != Kind || drv.Capabilities().Replies != transport.RepliesNative {
		t.Errorf("factory: %v", err)
	}
}

func TestRoundTripAndRequest(t *testing.T) {
	d, names := connect(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	request := names.Request("echo")
	instance := names.Instance("echo", "i1")
	control := names.Control("echo")
	t.Cleanup(func() {
		cctx, ccancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer ccancel()
		_ = d.DeleteChannels(cctx, request, instance, control)
		_ = d.Close()
	})
	specs := []transport.ChannelSpec{
		transport.RequestSpec(request, 0),
		{Name: instance, Role: transport.RoleInstance, Delivery: transport.DeliveryShared},
		{Name: control, Role: transport.RoleControl, Delivery: transport.DeliveryBroadcast, TTL: time.Minute},
	}
	if err := d.Declare(ctx, specs); err != nil {
		t.Fatal(err)
	}
	if err := d.Declare(ctx, specs); err != nil {
		t.Fatalf("declare is not idempotent: %v", err)
	}

	// Nobody listens on a queue that does not exist: reported at once.
	out, err := d.Publish(ctx, names.Request("ghost"), transport.WireEvent{Headers: map[string]string{"id": "x"}, Body: []byte("{}")}, transport.PublishOptions{})
	if err != nil || out != transport.Unroutable {
		t.Errorf("publish to a missing queue: %v %v, want unroutable", out, err)
	}
	if res, err := d.Request(ctx, names.Request("ghost"), transport.WireEvent{Headers: map[string]string{"id": "x"}, Body: []byte("{}")}, transport.RequestOptions{Timeout: 2 * time.Second}); err != nil || res.Outcome != transport.RequestUnroutable {
		t.Errorf("request to a missing queue: %+v %v", res, err)
	}
	// A declared queue nobody consumes is unroutable too (reported before anything is sent).
	out, err = d.Publish(ctx, request, transport.WireEvent{Headers: map[string]string{"specversion": "1.0", "id": "ev-0", "content-type": "application/json"}, Body: []byte(`{"n":0}`)}, transport.PublishOptions{TTL: time.Minute})
	if err != nil || out != transport.Unroutable {
		t.Fatalf("publish without consumers: %v %v, want unroutable", out, err)
	}
	if st, err := d.Stats(ctx, request); err != nil || st.Depth == nil || *st.Depth != 0 || st.Consumers == nil || *st.Consumers != 0 {
		t.Errorf("stats before consuming: %+v %v", st, err)
	}

	type seen struct {
		consumer int
		event    transport.WireEvent
		attempt  int
	}
	var mu sync.Mutex
	var got []seen
	var requeued atomic.Bool
	for i := 0; i < 2; i++ {
		i := i
		sub, err := d.Consume(ctx, request, transport.ConsumeOptions{Group: request, Prefetch: 2, AckMode: transport.AckManual}, func(ctx context.Context, event transport.WireEvent, del transport.Delivery) {
			if event.Headers["id"] == "ev-2" && requeued.CompareAndSwap(false, true) {
				_ = del.Nack(ctx, true)
				return
			}
			mu.Lock()
			got = append(got, seen{i, event, del.Attempt()})
			mu.Unlock()
			if replier, ok := del.(transport.Replier); ok && event.Headers["id"] == "ev-4" {
				_ = replier.Reply(ctx, transport.WireEvent{Headers: map[string]string{"specversion": "1.0", "id": "re-4", "lfcorrelation": "ev-4", "content-type": "application/json"}, Body: []byte(`{"ok":true}`)})
			}
			_ = del.Ack(ctx)
		})
		if err != nil {
			t.Fatal(err)
		}
		defer sub.Close(ctx)
	}
	for i := 0; i < 4; i++ {
		if out, err := d.Publish(ctx, request, transport.WireEvent{Headers: map[string]string{"specversion": "1.0", "id": fmt.Sprintf("ev-%d", i), "content-type": "application/json", "lfsig": "s"}, Body: []byte(fmt.Sprintf(`{"n":%d}`, i))}, transport.PublishOptions{}); err != nil || out != transport.Accepted {
			t.Fatal(out, err)
		}
	}
	// A native request gets its reply through direct reply-to.
	res, err := d.Request(ctx, request, transport.WireEvent{Headers: map[string]string{"specversion": "1.0", "id": "ev-4", "content-type": "application/json"}, Body: []byte(`{"n":4}`)}, transport.RequestOptions{Timeout: 10 * time.Second})
	if err != nil || res.Outcome != transport.RequestReplied {
		t.Fatalf("request: %+v %v", res, err)
	}
	if res.Event.Headers["id"] != "re-4" || res.Event.Headers["lfcorrelation"] != "ev-4" || string(res.Event.Body) != `{"ok":true}` || res.Event.Headers["content-type"] != "application/json" {
		t.Errorf("reply = %+v", res.Event)
	}
	// A request to a queue nobody consumes is reported unroutable, not awaited.
	if res, err := d.Request(ctx, instance, transport.WireEvent{Headers: map[string]string{"id": "lonely"}, Body: []byte("{}")}, transport.RequestOptions{Timeout: 500 * time.Millisecond}); err != nil || res.Outcome != transport.RequestUnroutable {
		t.Errorf("request without consumers: %+v %v", res, err)
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
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 5 {
		t.Fatalf("got %d deliveries, want 5: %+v", len(got), got)
	}
	ids := map[string]int{}
	for _, s := range got {
		ids[s.event.Headers["id"]]++
		if s.event.Headers["content-type"] != "application/json" {
			t.Errorf("content-type missing: %v", s.event.Headers)
		}
		if _, prefixed := s.event.Headers["cloudevents_id"]; prefixed {
			t.Error("the cloudEvents_ prefix leaked")
		}
		if s.event.Headers["id"] == "ev-2" && s.attempt != 2 {
			t.Errorf("requeued event attempt = %d, want 2", s.attempt)
		}
		if s.event.Headers["id"] != "ev-2" && s.attempt != 1 {
			t.Errorf("attempt of %s = %d", s.event.Headers["id"], s.attempt)
		}
	}
	for i := 0; i < 5; i++ {
		if ids[fmt.Sprintf("ev-%d", i)] != 1 {
			t.Errorf("ev-%d delivered %d times", i, ids[fmt.Sprintf("ev-%d", i)])
		}
	}
	if st, err := d.Stats(ctx, request); err != nil || st.Consumers == nil || *st.Consumers != 2 {
		t.Errorf("stats while consuming: %+v %v", st, err)
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
		_ = d.DeleteChannels(cctx, registry)
		_ = d.Close()
	})
	if err := d.Declare(ctx, []transport.ChannelSpec{{Name: registry, Role: transport.RoleRegistry, Delivery: transport.DeliveryBroadcast, TTL: time.Minute}}); err != nil {
		t.Fatal(err)
	}
	// No consumer yet: a broadcast with nobody bound is unroutable (mandatory on a fanout exchange).
	if out, err := d.Publish(ctx, registry, transport.WireEvent{Headers: map[string]string{"id": "old"}, Body: []byte("{}")}, transport.PublishOptions{TTL: time.Minute}); err != nil || out != transport.Unroutable {
		t.Errorf("broadcast without consumers: %v %v", out, err)
	}
	var counts [2]atomic.Int32
	for i := 0; i < 2; i++ {
		i := i
		sub, err := d.Consume(ctx, registry, transport.ConsumeOptions{AckMode: transport.AckAuto}, func(ctx context.Context, event transport.WireEvent, del transport.Delivery) {
			if event.Headers["id"] == "new" {
				counts[i].Add(1)
			}
			_ = del.Ack(ctx)
		})
		if err != nil {
			t.Fatal(err)
		}
		defer sub.Close(ctx)
	}
	if out, err := d.Publish(ctx, registry, transport.WireEvent{Headers: map[string]string{"id": "new"}, Body: []byte("{}")}, transport.PublishOptions{TTL: time.Minute}); err != nil || out != transport.Accepted {
		t.Fatal(out, err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) && (counts[0].Load() < 1 || counts[1].Load() < 1) {
		time.Sleep(20 * time.Millisecond)
	}
	if counts[0].Load() != 1 || counts[1].Load() != 1 {
		t.Errorf("broadcast counts = %d %d, want 1 1", counts[0].Load(), counts[1].Load())
	}
}

func TestNotConnected(t *testing.T) {
	d := New(Config{URL: "amqp://127.0.0.1:1/"})
	if _, err := d.Publish(context.Background(), "x", transport.WireEvent{}, transport.PublishOptions{}); !transport.IsNotConnected(err) {
		t.Errorf("publish before connect: %v", err)
	}
	if _, err := d.Request(context.Background(), "x", transport.WireEvent{}, transport.RequestOptions{}); !transport.IsNotConnected(err) {
		t.Errorf("request before connect: %v", err)
	}
	if err := d.Close(); err != nil {
		t.Error(err)
	}
	if err := d.Connect(context.Background()); !transport.IsNotConnected(err) {
		t.Errorf("connect after close: %v", err)
	}
}
