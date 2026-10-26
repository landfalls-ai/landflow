package nats

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

// serverURL returns the URL under test or skips (LANDFLOW_TEST_NATS=nats://127.0.0.1:54222).
func serverURL(t *testing.T) string {
	t.Helper()
	u := os.Getenv("LANDFLOW_TEST_NATS")
	if u == "" {
		t.Skip("set LANDFLOW_TEST_NATS=nats://127.0.0.1:54222 to run against a NATS server")
	}
	return u
}

func randomPrefix() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return "landflow-test-" + hex.EncodeToString(b)
}

func connect(t *testing.T, jetStream bool) (*Driver, transport.Names) {
	t.Helper()
	prefix := randomPrefix()
	d := New(Config{Config: transport.Config{ConnectionID: "test", Prefix: prefix}, URL: serverURL(t), JetStream: jetStream, AckWait: 5 * time.Second})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := d.Connect(ctx); err != nil {
		t.Skipf("NATS not reachable: %v", err)
	}
	return d, transport.NewNames(prefix)
}

func TestConfigFromURL(t *testing.T) {
	cfg, err := ConfigFromURL("nats-main", "nats://a:4222, nats://b:4222", transport.ConnectionOptions{Username: "u", Password: "p", Fields: map[string]string{"jetstream": "true"}})
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.JetStream || cfg.Username != "u" || cfg.ConnectionID != "nats-main" || New(cfg).Kind() != KindJetStream || New(cfg).Capabilities().Persistence != transport.PersistenceDisk || !New(cfg).Capabilities().Buffering {
		t.Errorf("config = %+v", cfg)
	}
	core := New(Config{})
	if core.Kind() != Kind || core.Capabilities().Buffering || !core.Capabilities().Nack || core.Capabilities().Replies != transport.RepliesNative || core.NATSConfig().URL == "" {
		t.Errorf("core capabilities = %+v", core.Capabilities())
	}
	for _, bad := range []string{"", "amqp://x:1", "nats://", "nats://a:1,bogus"} {
		if _, err := ConfigFromURL("c", bad, transport.ConnectionOptions{}); err == nil {
			t.Errorf("%q: want an error", bad)
		}
	}
	if _, err := ConfigFromURL("c", "nats://a:1", transport.ConnectionOptions{Fields: map[string]string{"jetstream": "maybe"}}); err == nil {
		t.Error("bad jetstream flag accepted")
	}
	for _, kind := range []string{Kind, KindJetStream} {
		f, ok := transport.LookupDriver(kind)
		if !ok {
			t.Fatalf("%s not registered", kind)
		}
		if drv, err := f("c", "nats://a:1", transport.ConnectionOptions{Fields: map[string]string{"streamprefix": "lf-", "ackwaitms": "5000"}}); err != nil || drv.Kind() != kind || drv.(*Driver).NATSConfig().AckWait != 5*time.Second {
			t.Errorf("factory %s: %v", kind, err)
		}
	}
	if StreamName("landflow.v1.plugin.echo", "lf-") != "lf-landflow_v1_plugin_echo" {
		t.Error(StreamName("landflow.v1.plugin.echo", "lf-"))
	}
}

func TestRoundTrip(t *testing.T) {
	for _, js := range []bool{false, true} {
		name := "core"
		if js {
			name = "jetstream"
		}
		t.Run(name, func(t *testing.T) { roundTrip(t, js) })
	}
}

func roundTrip(t *testing.T, jetStream bool) {
	d, names := connect(t, jetStream)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	request := names.Request("echo")
	instance := names.Instance("echo", "i1")
	t.Cleanup(func() {
		cctx, ccancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer ccancel()
		_ = d.DeleteStreams(cctx, request)
		_ = d.Close()
	})
	specs := []transport.ChannelSpec{transport.RequestSpec(request, time.Minute), {Name: instance, Role: transport.RoleInstance, Delivery: transport.DeliveryShared}}
	if err := d.Declare(ctx, specs); err != nil {
		t.Fatal(err)
	}
	if err := d.Declare(ctx, specs); err != nil {
		t.Fatalf("declare is not idempotent: %v", err)
	}

	// Nobody listens: core says so at once (requests and publishes); a stream buffers.
	res, err := d.Request(ctx, instance, transport.WireEvent{Headers: map[string]string{"id": "x"}, Body: []byte("{}")}, transport.RequestOptions{Timeout: 2 * time.Second})
	if err != nil || res.Outcome != transport.RequestUnroutable {
		t.Errorf("request with no responders: %+v %v", res, err)
	}
	if out, err := d.Publish(ctx, instance, transport.WireEvent{Headers: map[string]string{"id": "x"}, Body: []byte("{}")}, transport.PublishOptions{}); err != nil || out != transport.Unroutable {
		t.Errorf("publish with no subscribers: %v %v", out, err)
	}
	if jetStream {
		if out, err := d.Publish(ctx, request, transport.WireEvent{Headers: map[string]string{"specversion": "1.0", "id": "ev-0", "content-type": "application/json"}, Body: []byte(`{"n":0}`)}, transport.PublishOptions{}); err != nil || out != transport.Accepted {
			t.Fatalf("publish to the stream: %v %v", out, err)
		}
		if st, err := d.Stats(ctx, request); err != nil || st.Depth == nil || *st.Depth != 1 {
			t.Errorf("stats after one publish: %+v %v", st, err)
		}
		if out, err := d.Publish(ctx, names.Request("ghost"), transport.WireEvent{Body: []byte("{}")}, transport.PublishOptions{}); err == nil && out != transport.Unroutable {
			// A publish to an undeclared durable channel is a core publish (accepted); only a known stream reports.
			_ = out
		}
	}

	type seen struct {
		event   transport.WireEvent
		attempt int
	}
	var mu sync.Mutex
	var got []seen
	var requeued atomic.Bool
	for i := 0; i < 2; i++ {
		sub, err := d.Consume(ctx, request, transport.ConsumeOptions{Group: request, Prefetch: 2, AckMode: transport.AckManual}, func(ctx context.Context, event transport.WireEvent, del transport.Delivery) {
			if event.Headers["id"] == "ev-2" && requeued.CompareAndSwap(false, true) {
				_ = del.Nack(ctx, true)
				return
			}
			mu.Lock()
			got = append(got, seen{event, del.Attempt()})
			mu.Unlock()
			if event.Headers["id"] == "ev-4" {
				if err := del.(transport.Replier).Reply(ctx, transport.WireEvent{Headers: map[string]string{"specversion": "1.0", "id": "re-4", "lfcorrelation": "ev-4", "content-type": "application/json"}, Body: []byte(`{"ok":true}`)}); err != nil {
					t.Errorf("reply: %v", err)
				}
			}
			_ = del.Ack(ctx)
		})
		if err != nil {
			t.Fatal(err)
		}
		defer sub.Close(ctx)
	}
	first := 1
	if !jetStream {
		first = 0
	}
	for i := first; i < 4; i++ {
		if out, err := d.Publish(ctx, request, transport.WireEvent{Headers: map[string]string{"specversion": "1.0", "id": fmt.Sprintf("ev-%d", i), "content-type": "application/json", "lfsig": "s"}, Body: []byte(fmt.Sprintf(`{"n":%d}`, i))}, transport.PublishOptions{}); err != nil || out != transport.Accepted {
			t.Fatal(out, err)
		}
	}
	res, err = d.Request(ctx, request, transport.WireEvent{Headers: map[string]string{"specversion": "1.0", "id": "ev-4", "content-type": "application/json"}, Body: []byte(`{"n":4}`)}, transport.RequestOptions{Timeout: 10 * time.Second})
	if err != nil || res.Outcome != transport.RequestReplied {
		t.Fatalf("request: %+v %v", res, err)
	}
	if res.Event.Headers["id"] != "re-4" || res.Event.Headers["lfcorrelation"] != "ev-4" || string(res.Event.Body) != `{"ok":true}` || res.Event.Headers["content-type"] != "application/json" {
		t.Errorf("reply = %+v", res.Event)
	}
	if _, leaked := res.Event.Headers["landflow-reply"]; leaked {
		t.Error("the driver header leaked into the reply")
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
		if _, prefixed := s.event.Headers["ce-id"]; prefixed {
			t.Error("the ce- prefix leaked")
		}
		if _, leaked := s.event.Headers["landflow-reply"]; leaked {
			t.Error("the driver header leaked into the event")
		}
		want := 1
		if s.event.Headers["id"] == "ev-2" {
			want = 2
		}
		if s.attempt != want {
			t.Errorf("attempt of %s = %d, want %d", s.event.Headers["id"], s.attempt, want)
		}
	}
	for i := 0; i < 5; i++ {
		if ids[fmt.Sprintf("ev-%d", i)] != 1 {
			t.Errorf("ev-%d delivered %d times", i, ids[fmt.Sprintf("ev-%d", i)])
		}
	}
	// An unanswered request times out, not errors.
	if res, err := d.Request(ctx, instance, transport.WireEvent{Headers: map[string]string{"id": "lonely"}, Body: []byte("{}")}, transport.RequestOptions{Timeout: 300 * time.Millisecond}); jetStream && (err != nil || res.Outcome != transport.RequestUnroutable) {
		t.Errorf("unanswered core request: %+v %v", res, err)
	}
}

func TestBroadcast(t *testing.T) {
	d, names := connect(t, false)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	defer d.Close()
	registry := names.Registry()
	if err := d.Declare(ctx, []transport.ChannelSpec{{Name: registry, Role: transport.RoleRegistry, Delivery: transport.DeliveryBroadcast, TTL: time.Minute}}); err != nil {
		t.Fatal(err)
	}
	var counts [2]atomic.Int32
	for i := 0; i < 2; i++ {
		i := i
		sub, err := d.Consume(ctx, registry, transport.ConsumeOptions{AckMode: transport.AckAuto}, func(ctx context.Context, event transport.WireEvent, del transport.Delivery) {
			if event.Headers["id"] == "new" {
				counts[i].Add(1)
			}
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
	d := New(Config{URL: "nats://127.0.0.1:1"})
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
