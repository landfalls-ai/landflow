package mqtt

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/landflow/landflow/sdks/go/transport"
)

// brokerURL returns the URL under test or skips (LANDFLOW_TEST_MQTT=mqtt://127.0.0.1:51883).
func brokerURL(t *testing.T) string {
	t.Helper()
	u := os.Getenv("LANDFLOW_TEST_MQTT")
	if u == "" {
		t.Skip("set LANDFLOW_TEST_MQTT=mqtt://127.0.0.1:51883 to run against Mosquitto")
	}
	return u
}

func TestConfigFromURL(t *testing.T) {
	cfg, err := ConfigFromURL("mosq", "mqtt://old:pw@127.0.0.1:51883", transport.ConnectionOptions{Username: "u", Password: "p", TLS: true, Prefix: "acme", Fields: map[string]string{"client_id": "plugin-1"}})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.URL != "mqtts://127.0.0.1:51883" || cfg.Username != "u" || cfg.Password != "p" || cfg.ClientID != "plugin-1" || cfg.ConnectionID != "mosq" || cfg.Prefix != "acme" {
		t.Errorf("config = %+v", cfg)
	}
	if cfg, err := ConfigFromURL("m", "mqtt://u:p%40ss@h:1883", transport.ConnectionOptions{}); err != nil || cfg.URL != "mqtt://h:1883" || cfg.Username != "u" || cfg.Password != "p@ss" {
		t.Errorf("credentials from the URL: %+v %v", cfg, err)
	}
	for url, want := range map[string]string{"tcp://h:1883": "mqtt://h:1883", "ssl://h:8883": "mqtts://h:8883", "ws://h/mqtt": "ws://h/mqtt", "wss://h/mqtt": "wss://h/mqtt"} {
		if cfg, err := ConfigFromURL("m", url, transport.ConnectionOptions{}); err != nil || cfg.URL != want {
			t.Errorf("%s: %+v %v, want %s", url, cfg, err, want)
		}
	}
	if cfg, _ := ConfigFromURL("m", "ws://h/mqtt", transport.ConnectionOptions{TLS: true}); cfg.URL != "wss://h/mqtt" {
		t.Errorf("TLS on ws: %s", cfg.URL)
	}
	if New(cfg).MQTTConfig().MaxMessageBytes != 1<<20 {
		t.Error("default limit")
	}
	for _, bad := range []string{"", "amqp://x:1", "mqtt:///", "not a url"} {
		if _, err := ConfigFromURL("c", bad, transport.ConnectionOptions{}); err == nil {
			t.Errorf("%q: want an error", bad)
		}
	}
	f, ok := transport.LookupDriver("mqtt")
	if !ok {
		t.Fatal("driver not registered")
	}
	drv, err := f("c", "mqtt://x:1", transport.ConnectionOptions{})
	if err != nil || drv.Kind() != Kind {
		t.Fatalf("factory: %v", err)
	}
	caps := drv.Capabilities()
	if caps.Replies != transport.RepliesNative || caps.Buffering || !caps.TTL || caps.Undeliverable != transport.UndeliverableReported || !caps.Nack || !caps.Attempts || caps.OrderingKeys {
		t.Errorf("capabilities = %+v", caps)
	}
	if _, ok := drv.(transport.StatsReporter); ok {
		t.Error("mqtt has no stats")
	}
}

func TestMapping(t *testing.T) {
	if TopicOf("landflow.v1.plugin.twilio") != "landflow/v1/plugin/twilio" || ChannelOf("landflow/v1/instance/t/abc") != "landflow.v1.instance.t.abc" {
		t.Error("topic mapping")
	}
	for channel, shared := range map[string]bool{"landflow.v1.plugin.x": true, "landflow.v1.instance.x.i": true, "landflow.v1.control.x": false, "landflow.v1.registry": false, "landflow.v1.reply.h": false, "lfconf.ab.x": true} {
		if InferShared(channel) != shared {
			t.Errorf("InferShared(%s) != %v", channel, shared)
		}
	}
	if expirySeconds(20*time.Millisecond) != 1 || expirySeconds(1500*time.Millisecond) != 2 {
		t.Error("expiry rounding")
	}
}

func TestNotConnected(t *testing.T) {
	d := New(Config{URL: "mqtt://127.0.0.1:1"})
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
	dead := New(Config{URL: "mqtt://127.0.0.1:1", ConnectTimeout: 2 * time.Second})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := dead.Connect(ctx); err == nil {
		t.Error("connect to a closed port succeeded")
	}
	if _, err := dead.Publish(context.Background(), "x", transport.WireEvent{}, transport.PublishOptions{}); !transport.IsNotConnected(err) {
		t.Errorf("publish after a failed connect: %v", err)
	}
	_ = dead.Close()
}

// TestUnroutableAndReply checks the broker-specific parts outside the suite: PUBACK 0x10 and the response topic.
func TestUnroutableAndReply(t *testing.T) {
	d := New(Config{Config: transport.Config{ConnectionID: "t", Prefix: "lfmqtt" + newHex(3)}, URL: brokerURL(t)})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := d.Connect(ctx); err != nil {
		t.Skipf("Mosquitto not reachable: %v", err)
	}
	defer d.Close()
	names := transport.NewNames(d.MQTTConfig().Prefix)
	request := names.Request("echo")
	if err := d.Declare(ctx, []transport.ChannelSpec{transport.RequestSpec(request, 0)}); err != nil {
		t.Fatal(err)
	}
	if out, err := d.Publish(ctx, request, transport.WireEvent{Headers: map[string]string{"id": "x"}, Body: []byte("{}")}, transport.PublishOptions{}); err != nil || out != transport.Unroutable {
		t.Errorf("publish to nobody: %v %v", out, err)
	}
	if out, err := d.Publish(ctx, names.Registry(), transport.WireEvent{Headers: map[string]string{"id": "x"}, Body: []byte("{}")}, transport.PublishOptions{TTL: time.Minute}); err != nil || out != transport.Accepted {
		t.Errorf("QoS 0 publish to nobody: %v %v", out, err)
	}
	sub, err := d.Consume(ctx, request, transport.ConsumeOptions{Group: request, Prefetch: 2, AckMode: transport.AckManual}, func(ctx context.Context, event transport.WireEvent, del transport.Delivery) {
		if _, leaked := event.Headers[AttemptProperty]; leaked {
			t.Error("the attempt property leaked")
		}
		if event.Headers["content-type"] != "application/json" || event.Headers["id"] != "q1" {
			t.Errorf("headers = %v", event.Headers)
		}
		_ = del.Ack(ctx)
		_ = del.(transport.Replier).Reply(ctx, transport.WireEvent{Headers: map[string]string{"id": "r1", "lfcorrelation": "q1", "content-type": "application/json"}, Body: []byte(`{"ok":true}`)})
	})
	if err != nil {
		t.Fatal(err)
	}
	defer sub.Close(ctx)
	res, err := d.Request(ctx, request, transport.WireEvent{Headers: map[string]string{"id": "q1", "content-type": "application/json"}, Body: []byte(`{}`)}, transport.RequestOptions{Timeout: 10 * time.Second})
	if err != nil || res.Outcome != transport.RequestReplied || res.Event.Headers["id"] != "r1" || string(res.Event.Body) != `{"ok":true}` {
		t.Fatalf("request: %+v %v", res, err)
	}
}
