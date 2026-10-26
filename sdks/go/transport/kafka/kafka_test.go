package kafka

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

// broker returns the address under test or skips (LANDFLOW_TEST_KAFKA=127.0.0.1:59092).
func broker(t *testing.T) string {
	t.Helper()
	addr := os.Getenv("LANDFLOW_TEST_KAFKA")
	if addr == "" {
		t.Skip("set LANDFLOW_TEST_KAFKA=127.0.0.1:59092 to run against a Kafka broker")
	}
	return addr
}

func randomPrefix() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return "landflow-test-" + hex.EncodeToString(b)
}

func connect(t *testing.T, mode Mode) (*Driver, transport.Names) {
	t.Helper()
	prefix := randomPrefix()
	d := New(Config{Config: transport.Config{ConnectionID: "test", Prefix: prefix}, Brokers: []string{broker(t)}, Mode: mode, Partitions: 2})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := d.Connect(ctx); err != nil {
		t.Skipf("Kafka at %s not reachable: %v", broker(t), err)
	}
	return d, transport.NewNames(prefix)
}

func TestConfigFromURL(t *testing.T) {
	cfg, err := ConfigFromURL("kafka-main", "kafka://a:9092,b:9093/", transport.ConnectionOptions{Prefix: "lf", Fields: map[string]string{"mode": "group", "partitions": "6"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Brokers) != 2 || cfg.Brokers[1] != "b:9093" || cfg.Mode != ModeGroup || cfg.Partitions != 6 || cfg.Prefix != "lf" || cfg.ConnectionID != "kafka-main" {
		t.Errorf("config = %+v", cfg)
	}
	for _, bad := range []string{"", "amqp://x:1", "kafka://", "kafka://nohost"} {
		if _, err := ConfigFromURL("c", bad, transport.ConnectionOptions{}); err == nil {
			t.Errorf("%q: want an error", bad)
		}
	}
	if _, err := ConfigFromURL("c", "kafka://a:1", transport.ConnectionOptions{Fields: map[string]string{"mode": "weird"}}); err == nil {
		t.Error("bad mode accepted")
	}
	f, ok := transport.LookupDriver("kafka")
	if !ok {
		t.Fatal("driver not registered")
	}
	drv, err := f("c", "kafka://a:1", transport.ConnectionOptions{})
	if err != nil || drv.Kind() != Kind || !drv.Capabilities().Nack || drv.(*Driver).KafkaConfig().Mode != ModeShare {
		t.Errorf("factory: %v %+v", err, drv)
	}
	if !New(Config{Mode: ModeGroup}).Capabilities().Nack || New(Config{Mode: ModeGroup}).Capabilities().Attempts || !New(Config{Mode: ModeShare}).Capabilities().Attempts || New(Config{}).KafkaConfig().Partitions != 6 {
		t.Error("group mode requeues by republishing but cannot count attempts; share mode counts them; partitions default to 6")
	}
}

func TestRoundTrip(t *testing.T) {
	for _, mode := range []Mode{ModeShare, ModeGroup} {
		t.Run(string(mode), func(t *testing.T) { roundTrip(t, mode) })
	}
}

func roundTrip(t *testing.T, mode Mode) {
	d, names := connect(t, mode)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	request := names.Request("echo")
	control := names.Control("echo")
	t.Cleanup(func() {
		cctx, ccancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer ccancel()
		_ = d.DeleteGroups(cctx, request)
		_ = d.DeleteTopics(cctx, request, control)
		_ = d.Close()
	})
	if err := d.Declare(ctx, []transport.ChannelSpec{
		transport.RequestSpec(request, 0),
		{Name: control, Role: transport.RoleControl, Delivery: transport.DeliveryBroadcast, TTL: time.Minute},
	}); err != nil {
		t.Fatal(err)
	}
	if err := d.Declare(ctx, []transport.ChannelSpec{transport.RequestSpec(request, 0)}); err != nil {
		t.Fatalf("declare is not idempotent: %v", err)
	}

	// Two competing consumers share the request topic; one of the events is requeued once.
	type seen struct {
		consumer int
		event    transport.WireEvent
		attempt  int
	}
	var mu sync.Mutex
	var got []seen
	var requeued atomic.Bool
	var subs []transport.Subscription
	for i := 0; i < 2; i++ {
		i := i
		sub, err := d.Consume(ctx, request, transport.ConsumeOptions{Group: request, Prefetch: 2, AckMode: transport.AckManual}, func(ctx context.Context, event transport.WireEvent, del transport.Delivery) {
			if event.Headers["id"] == "ev-2" && d.Capabilities().Nack && requeued.CompareAndSwap(false, true) {
				_ = del.Nack(ctx, true)
				return
			}
			mu.Lock()
			got = append(got, seen{i, event, del.Attempt()})
			mu.Unlock()
			_ = del.Ack(ctx)
		})
		if err != nil {
			t.Fatal(err)
		}
		subs = append(subs, sub)
	}
	for i := 0; i < 5; i++ {
		event := transport.WireEvent{
			Headers: map[string]string{"specversion": "1.0", "id": fmt.Sprintf("ev-%d", i), "type": "dev.landflow.test", "content-type": "application/json", "lfsig": "abc"},
			Body:    []byte(fmt.Sprintf(`{"n":%d}`, i)),
		}
		out, err := d.Publish(ctx, request, event, transport.PublishOptions{OrderingKey: "exec-1"})
		if err != nil || out != transport.Accepted {
			t.Fatalf("publish %d: %v %v", i, out, err)
		}
	}
	deadline := time.Now().Add(30 * time.Second)
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
		if s.event.Headers["type"] != "dev.landflow.test" || s.event.Headers["content-type"] != "application/json" || s.event.Headers["lfsig"] != "abc" {
			t.Errorf("headers did not round-trip: %v", s.event.Headers)
		}
		if _, prefixed := s.event.Headers["ce_id"]; prefixed {
			t.Error("the ce_ prefix leaked into the event")
		}
		if s.event.Headers["id"] == "ev-2" && d.Capabilities().Attempts && s.attempt != 2 {
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
	if !requeued.Load() {
		t.Error("the requeue never happened")
	}
	for _, s := range subs {
		if err := s.Close(ctx); err != nil {
			t.Error(err)
		}
	}
	// Stats name the group's members (now zero) without failing.
	if _, err := d.Stats(ctx, request); err != nil {
		t.Errorf("stats: %v", err)
	}
}

func TestBroadcast(t *testing.T) {
	d, names := connect(t, ModeGroup)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	registry := names.Registry()
	t.Cleanup(func() {
		cctx, ccancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer ccancel()
		_ = d.DeleteTopics(cctx, registry)
		_ = d.Close()
	})
	if err := d.Declare(ctx, []transport.ChannelSpec{{Name: registry, Role: transport.RoleRegistry, Delivery: transport.DeliveryBroadcast, TTL: time.Minute}}); err != nil {
		t.Fatal(err)
	}
	// Published before anyone listens: a broadcast consumer starts at the end and never sees it.
	if _, err := d.Publish(ctx, registry, transport.WireEvent{Headers: map[string]string{"id": "old"}, Body: []byte("{}")}, transport.PublishOptions{}); err != nil {
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
	if _, err := d.Publish(ctx, registry, transport.WireEvent{Headers: map[string]string{"id": "new"}, Body: []byte("{}")}, transport.PublishOptions{}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) && (counts[0].Load() < 1 || counts[1].Load() < 1) {
		time.Sleep(50 * time.Millisecond)
	}
	if counts[0].Load() != 1 || counts[1].Load() != 1 {
		t.Errorf("broadcast counts = %d %d, want 1 1", counts[0].Load(), counts[1].Load())
	}
}

func TestNotConnected(t *testing.T) {
	d := New(Config{Brokers: []string{"127.0.0.1:1"}})
	if _, err := d.Publish(context.Background(), "x", transport.WireEvent{}, transport.PublishOptions{}); !transport.IsNotConnected(err) {
		t.Errorf("publish before connect: %v", err)
	}
	if _, err := d.Consume(context.Background(), "x", transport.ConsumeOptions{}, nil); !transport.IsNotConnected(err) {
		t.Errorf("consume before connect: %v", err)
	}
	if err := d.Close(); err != nil {
		t.Error(err)
	}
	if err := d.Connect(context.Background()); !transport.IsNotConnected(err) {
		t.Errorf("connect after close: %v", err)
	}
}
