package sqs

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/landflow/landflow/sdks/go/transport"
)

// TestMain turns the shared AWS files off for every test in this package: only the explicit LocalStack endpoint and
// dummy credentials are ever used.
func TestMain(m *testing.M) {
	os.Setenv("AWS_SHARED_CREDENTIALS_FILE", "/dev/null")
	os.Setenv("AWS_CONFIG_FILE", "/dev/null")
	os.Exit(m.Run())
}

// endpointURL returns the endpoint under test or skips (LANDFLOW_TEST_SQS=http://127.0.0.1:54566, the landflow-infra LocalStack).
func endpointURL(t *testing.T) string {
	t.Helper()
	u := os.Getenv("LANDFLOW_TEST_SQS")
	if u == "" {
		t.Skip("set LANDFLOW_TEST_SQS=http://127.0.0.1:54566 to run against LocalStack")
	}
	return u
}

func randomPrefix() string {
	b := make([]byte, 3)
	_, _ = rand.Read(b)
	return "lftest-" + hex.EncodeToString(b) + "-"
}

func testConfig(t *testing.T, prefix string) Config {
	t.Helper()
	return Config{
		Config: transport.Config{ConnectionID: "sqs-test", Prefix: strings.TrimSuffix(prefix, "-")}, Endpoint: endpointURL(t), AccessKeyID: DummyAccessKey, SecretAccessKey: DummySecretKey,
		QueuePrefix: prefix, VisibilityTimeout: 3 * time.Second, WaitTime: 2 * time.Second, FanoutRefresh: 250 * time.Millisecond,
	}
}

func TestConfigFromURL(t *testing.T) {
	cfg, err := ConfigFromURL("sqs-main", "http://127.0.0.1:54566/", transport.ConnectionOptions{Username: "test", Password: "test", Prefix: "lf", Fields: map[string]string{"region": "eu-west-1", "queueprefix": "q-"}})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Endpoint != "http://127.0.0.1:54566" || cfg.Region != "eu-west-1" || cfg.AccessKeyID != "test" || cfg.SecretAccessKey != "test" || cfg.Prefix != "lf" || cfg.QueuePrefix != "q-" || cfg.AllowAWS {
		t.Errorf("config = %+v", cfg)
	}
	if cfg, err := ConfigFromURL("c", "sqs://localstack:4566", transport.ConnectionOptions{}); err != nil || cfg.Endpoint != "http://localstack:4566" || cfg.Region != DefaultRegion {
		t.Errorf("sqs:// = %+v %v", cfg, err)
	}
	if cfg, err := ConfigFromURL("c", "sqs://sqs.eu-west-1.amazonaws.com", transport.ConnectionOptions{TLS: true}); err != nil || cfg.Endpoint != "https://sqs.eu-west-1.amazonaws.com" {
		t.Errorf("sqs:// tls = %+v %v", cfg, err)
	}
	if cfg, err := ConfigFromURL("c", "http://127.0.0.1:54566?region=us-west-2", transport.ConnectionOptions{Fields: map[string]string{"endpoint": "http://10.0.0.5:4566"}}); err != nil || cfg.Endpoint != "http://10.0.0.5:4566" || cfg.Region != "us-west-2" {
		t.Errorf("field endpoint = %+v %v", cfg, err)
	}
	// The guard against real AWS: no endpoint means an error unless allowaws is set.
	for _, bad := range []struct {
		url  string
		opts transport.ConnectionOptions
	}{
		{"", transport.ConnectionOptions{}},
		{"sqs://aws", transport.ConnectionOptions{}},
		{"sqs://aws/eu-west-1", transport.ConnectionOptions{Fields: map[string]string{"allowaws": "false"}}},
		{"amqp://x:1", transport.ConnectionOptions{}},
		{"http://127.0.0.1:54566", transport.ConnectionOptions{Fields: map[string]string{"region": "Mars"}}},
		{"http://127.0.0.1:54566", transport.ConnectionOptions{Username: "only-key"}},
		{"http://127.0.0.1:54566", transport.ConnectionOptions{Fields: map[string]string{"endpoint": "ftp://x"}}},
		{"http://127.0.0.1:54566", transport.ConnectionOptions{Fields: map[string]string{"maxmessagebytes": "2000000"}}},
	} {
		if _, err := ConfigFromURL("c", bad.url, bad.opts); err == nil {
			t.Errorf("%q %+v: want an error", bad.url, bad.opts.Fields)
		}
	}
	if cfg, err := ConfigFromURL("c", "sqs://aws/eu-west-1", transport.ConnectionOptions{Fields: map[string]string{"allowaws": "true"}}); err != nil || !cfg.AllowAWS || cfg.Endpoint != "" || cfg.Region != "eu-west-1" {
		t.Errorf("allowaws = %+v %v", cfg, err)
	}
	if f, ok := transport.LookupDriver("sqs"); !ok {
		t.Fatal("driver not registered")
	} else if drv, err := f("c", "http://127.0.0.1:54566", transport.ConnectionOptions{}); err != nil || drv.Kind() != Kind || drv.Capabilities().Headers || drv.Capabilities().Undeliverable != transport.UndeliverableUnknown {
		t.Errorf("factory: %v", err)
	}
	// Connect refuses without an endpoint before touching the AWS SDK's default chain.
	if err := New(Config{Region: "us-east-1"}).Connect(context.Background()); err == nil || !strings.Contains(err.Error(), "explicit endpoint") {
		t.Errorf("connect without endpoint: %v", err)
	}
}

func TestQueueNames(t *testing.T) {
	if got := QueueName("landflow.v1.plugin.twilio", ""); got != "landflow_v1_plugin_twilio" {
		t.Errorf("queue name %q", got)
	}
	long := "landflow.v1.instance." + strings.Repeat("p", 60) + "." + strings.Repeat("i", 32)
	name := QueueName(long, "")
	if len(name) != 80 || name != QueueName(long, "") || name == QueueName(long+"x", "") {
		t.Errorf("long name %q", name)
	}
	if got := BroadcastPrefix("landflow.v1.registry", ""); got != "landflow_v1_registry--bc-" {
		t.Errorf("broadcast prefix %q", got)
	}
	if p := BroadcastPrefix("landflow.v1.reply."+strings.Repeat("h", 100), ""); len(p)+10 > 80 || !strings.HasSuffix(p, "--bc-") {
		t.Errorf("long broadcast prefix %q", p)
	}
	for channel, want := range map[string]bool{"landflow.v1.reply.host-1": true, "acme.v1.registry": true, "landflow.v1.control.twilio": true, "landflow.v1.plugin.twilio": false, "landflow.v1.instance.twilio.abc": false, "lfconf.abcd.name": false} {
		if got := IsBroadcastChannel(channel, transport.ChannelSpec{}, false); got != want {
			t.Errorf("IsBroadcastChannel(%q) = %v", channel, got)
		}
	}
	if !IsBroadcastChannel("x", transport.ChannelSpec{Delivery: transport.DeliveryBroadcast}, true) {
		t.Error("a declared spec should win")
	}
}

func TestMessageEncoding(t *testing.T) {
	text := transport.WireEvent{Headers: map[string]string{"content-type": "application/cloudevents+json"}, Body: []byte(`{"specversion":"1.0","ü":1}`)}
	body, attrs := ToMessage(text)
	if body != string(text.Body) || len(attrs) != 1 || *attrs["content-type"].StringValue != "application/cloudevents+json" {
		t.Errorf("text: %q %+v", body, attrs)
	}
	if back := FromMessage(body, attrs); string(back.Body) != string(text.Body) || back.Headers["content-type"] != "application/cloudevents+json" {
		t.Errorf("text back: %+v", back)
	}
	binary := transport.WireEvent{Body: []byte{0, 1, 2, 255, 254}}
	body, attrs = ToMessage(binary)
	if *attrs["lf-encoding"].StringValue != "base64" {
		t.Errorf("binary: %+v", attrs)
	}
	if back := FromMessage(body, attrs); string(back.Body) != string(binary.Body) {
		t.Errorf("binary back: %v", back.Body)
	}
	if _, attrs := ToMessage(transport.WireEvent{Body: []byte("a\x01b")}); *attrs["lf-encoding"].StringValue != "base64" {
		t.Error("control characters must be base64")
	}
	body, attrs = ToMessage(transport.WireEvent{})
	if body != "-" || *attrs["lf-encoding"].StringValue != "empty" || len(FromMessage(body, attrs).Body) != 0 {
		t.Errorf("empty: %q %+v", body, attrs)
	}
	if !IsSQSText("tab\t nl\n ok ünï 😀") || IsSQSText("\x00") || IsSQSText("￾") {
		t.Error("IsSQSText")
	}
}

func TestRoundTrip(t *testing.T) {
	prefix := randomPrefix()
	d := New(testConfig(t, prefix))
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if err := d.Connect(ctx); err != nil {
		t.Skipf("LocalStack not reachable: %v", err)
	}
	names := transport.NewNames(strings.TrimSuffix(prefix, "-"))
	request, reply := names.Request("echo"), names.Reply("host-1")
	t.Cleanup(func() {
		cctx, ccancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer ccancel()
		_ = d.DeleteQueues(cctx, request, reply)
		_ = d.Close()
	})
	if err := d.Declare(ctx, []transport.ChannelSpec{transport.RequestSpec(request, 0), transport.ReplySpec(reply)}); err != nil {
		t.Fatal(err)
	}
	// A reply published by a driver that never declared the reply channel (a plugin's) still reaches the host's consumer queue.
	other := New(testConfig(t, prefix))
	if err := other.Connect(ctx); err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	got := make(chan transport.WireEvent, 4)
	sub, err := d.Consume(ctx, reply, transport.ConsumeOptions{Prefetch: 4, AckMode: transport.AckAuto}, func(_ context.Context, e transport.WireEvent, _ transport.Delivery) { got <- e })
	if err != nil {
		t.Fatal(err)
	}
	defer sub.Close(ctx)
	if _, err := other.Publish(ctx, reply, transport.WireEvent{Headers: map[string]string{"content-type": "application/json"}, Body: []byte(`{"ok":true}`)}, transport.PublishOptions{}); err != nil {
		t.Fatal(err)
	}
	select {
	case e := <-got:
		if string(e.Body) != `{"ok":true}` || e.Headers["content-type"] != "application/json" {
			t.Errorf("reply event: %+v", e)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("no reply delivered to the per-consumer queue")
	}
	// Attempts come from ApproximateReceiveCount: a requeue is delivered again as attempt 2.
	attempts := make(chan int, 4)
	rsub, err := d.Consume(ctx, request, transport.ConsumeOptions{Group: request, Prefetch: 1, AckMode: transport.AckManual}, func(ctx context.Context, _ transport.WireEvent, del transport.Delivery) {
		attempts <- del.Attempt()
		if del.Attempt() == 1 {
			_ = del.Nack(ctx, true)
		} else {
			_ = del.Ack(ctx)
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	defer rsub.Close(ctx)
	if _, err := d.Publish(ctx, request, transport.WireEvent{Body: []byte("again")}, transport.PublishOptions{}); err != nil {
		t.Fatal(err)
	}
	for _, want := range []int{1, 2} {
		select {
		case a := <-attempts:
			if a != want {
				t.Errorf("attempt %d, want %d", a, want)
			}
		case <-time.After(15 * time.Second):
			t.Fatalf("no delivery with attempt %d", want)
		}
	}
	stats, err := d.Stats(ctx, request)
	if err != nil || stats.Depth == nil || stats.Consumers != nil {
		t.Errorf("stats = %+v %v", stats, err)
	}
}
