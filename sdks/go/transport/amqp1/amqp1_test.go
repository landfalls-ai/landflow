package amqp1

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/landflow/landflow/sdks/go/transport"
)

// brokerURL returns the URL under test or skips (LANDFLOW_TEST_AMQP1=amqp://user:pass@127.0.0.1:55674).
func brokerURL(t *testing.T) string {
	t.Helper()
	u := os.Getenv("LANDFLOW_TEST_AMQP1")
	if u == "" {
		t.Skip("set LANDFLOW_TEST_AMQP1=amqp://user:pass@127.0.0.1:55674 to run against Artemis")
	}
	return u
}

// connect opens a driver on the broker under test with a random prefix.
func connect(t *testing.T) (*Driver, transport.Names) {
	t.Helper()
	cfg, err := ConfigFromURL("test", brokerURL(t), transport.ConnectionOptions{Prefix: "lfamqp1" + newHex(3)})
	if err != nil {
		t.Fatal(err)
	}
	d := New(cfg)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := d.Connect(ctx); err != nil {
		t.Skipf("Artemis not reachable: %v", err)
	}
	return d, transport.NewNames(cfg.Prefix)
}

func TestConfigFromURL(t *testing.T) {
	cfg, err := ConfigFromURL("art", "amqp://old:pw@127.0.0.1:55674", transport.ConnectionOptions{Username: "u", Password: "p", TLS: true, Prefix: "acme"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.URL != "amqps://127.0.0.1:55674" || cfg.Username != "u" || cfg.Password != "p" || cfg.ConnectionID != "art" || cfg.Prefix != "acme" {
		t.Errorf("config = %+v", cfg)
	}
	if cfg, err := ConfigFromURL("a", "amqp://u:p%40ss@h:5672", transport.ConnectionOptions{}); err != nil || cfg.URL != "amqp://h:5672" || cfg.Username != "u" || cfg.Password != "p@ss" {
		t.Errorf("credentials from the URL: %+v %v", cfg, err)
	}
	if cfg, err := ConfigFromURL("a", "amqp+ssl://h:5671", transport.ConnectionOptions{}); err != nil || cfg.URL != "amqps://h:5671" {
		t.Errorf("amqp+ssl: %+v %v", cfg, err)
	}
	if New(cfg).AMQP1Config().MaxMessageBytes != 1<<20 {
		t.Error("default limit")
	}
	for _, bad := range []string{"", "mqtt://x:1", "amqp:///", "not a url"} {
		if _, err := ConfigFromURL("c", bad, transport.ConnectionOptions{}); err == nil {
			t.Errorf("%q: want an error", bad)
		}
	}
	f, ok := transport.LookupDriver("amqp1")
	if !ok {
		t.Fatal("driver not registered")
	}
	drv, err := f("c", "amqp://x:1", transport.ConnectionOptions{})
	if err != nil || drv.Kind() != Kind {
		t.Fatalf("factory: %v", err)
	}
	caps := drv.Capabilities()
	if caps.Replies != transport.RepliesNative || !caps.Buffering || !caps.TTL || caps.Undeliverable != transport.UndeliverableInferred || !caps.Nack || !caps.Attempts || !caps.OrderingKeys {
		t.Errorf("capabilities = %+v", caps)
	}
	if _, ok := drv.(transport.StatsReporter); !ok {
		t.Error("amqp1 reports stats")
	}
	for channel, role := range map[string]string{"landflow.v1.plugin.x": "queue", "landflow.v1.instance.x.i": "queue", "landflow.v1.control.x": "topic", "landflow.v1.registry": "topic", "landflow.v1.reply.h": "topic", "whatever": "queue"} {
		if InferRole(channel) != role {
			t.Errorf("InferRole(%s) != %s", channel, role)
		}
	}
}

func TestNotConnected(t *testing.T) {
	d := New(Config{URL: "amqp://127.0.0.1:1"})
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
	dead := New(Config{URL: "amqp://127.0.0.1:1", ConnectTimeout: 2 * time.Second})
	if err := dead.Connect(context.Background()); err == nil {
		t.Error("connect to a closed port succeeded")
	}
	if _, err := dead.Publish(context.Background(), "x", transport.WireEvent{}, transport.PublishOptions{}); !transport.IsNotConnected(err) {
		t.Errorf("publish after a failed connect: %v", err)
	}
	_ = dead.Close()
}

// TestStatsAndReply checks the broker-specific parts outside the suite: management stats, the reply queue, delivery-count.
func TestStatsAndReply(t *testing.T) {
	d, names := connect(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	request := names.Request("echo")
	t.Cleanup(func() {
		cctx, ccancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer ccancel()
		_ = d.DeleteChannels(cctx, request)
		_ = d.Close()
	})
	if err := d.Declare(ctx, []transport.ChannelSpec{transport.RequestSpec(request, 0)}); err != nil {
		t.Fatal(err)
	}
	// Buffered before any consumer (the sender's attach created the queue), visible in the stats.
	if out, err := d.Publish(ctx, request, transport.WireEvent{Headers: map[string]string{"id": "early", "content-type": "application/json"}, Body: []byte(`{}`)}, transport.PublishOptions{TTL: time.Minute}); err != nil || out != transport.Accepted {
		t.Fatalf("publish: %v %v", out, err)
	}
	if st, err := d.Stats(ctx, request); err != nil || st.Depth == nil || *st.Depth != 1 || st.Consumers == nil || *st.Consumers != 0 {
		t.Errorf("stats before consuming: %+v %v", st, err)
	}
	if st, err := d.Stats(ctx, names.Request("nope")); err != nil || st.Depth == nil || *st.Depth != 0 {
		t.Errorf("stats of a missing queue: %+v %v", st, err)
	}
	attempts := make(chan int, 4)
	sub, err := d.Consume(ctx, request, transport.ConsumeOptions{Group: request, Prefetch: 2, AckMode: transport.AckManual}, func(ctx context.Context, event transport.WireEvent, del transport.Delivery) {
		if _, leaked := event.Headers["cloudevents_id"]; leaked {
			t.Error("the cloudEvents_ prefix leaked")
		}
		if event.Headers["id"] == "early" && del.Attempt() == 1 {
			attempts <- 1
			_ = del.Nack(ctx, true)
			return
		}
		attempts <- del.Attempt()
		_ = del.Ack(ctx)
		if replier, ok := del.(transport.Replier); ok && event.Headers["id"] == "q1" {
			_ = replier.Reply(ctx, transport.WireEvent{Headers: map[string]string{"id": "r1", "lfcorrelation": "q1", "content-type": "application/json"}, Body: []byte(`{"ok":true}`)})
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	defer sub.Close(ctx)
	if a := <-attempts; a != 1 {
		t.Errorf("first attempt = %d", a)
	}
	if a := <-attempts; a != 2 {
		t.Errorf("redelivered attempt = %d, want 2", a)
	}
	res, err := d.Request(ctx, request, transport.WireEvent{Headers: map[string]string{"id": "q1", "content-type": "application/json"}, Body: []byte(`{}`)}, transport.RequestOptions{Timeout: 10 * time.Second, OrderingKey: "exec-1"})
	if err != nil || res.Outcome != transport.RequestReplied || res.Event.Headers["id"] != "r1" || res.Event.Headers["content-type"] != "application/json" || string(res.Event.Body) != `{"ok":true}` {
		t.Fatalf("request: %+v %v", res, err)
	}
	if st, err := d.Stats(ctx, request); err != nil || st.Consumers == nil || *st.Consumers != 1 {
		t.Errorf("stats while consuming: %+v %v", st, err)
	}
}
