package pubsub

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

// TestMain makes sure no Google credentials of the machine are ever picked up: the emulator alone is used.
func TestMain(m *testing.M) {
	os.Unsetenv("GOOGLE_APPLICATION_CREDENTIALS")
	os.Exit(m.Run())
}

// emulatorHost returns the emulator under test or skips (LANDFLOW_TEST_PUBSUB=127.0.0.1:58085, the landflow-infra emulator).
func emulatorHost(t *testing.T) string {
	t.Helper()
	h := os.Getenv("LANDFLOW_TEST_PUBSUB")
	if h == "" {
		t.Skip("set LANDFLOW_TEST_PUBSUB=127.0.0.1:58085 to run against the Pub/Sub emulator")
	}
	return h
}

func projectID() string {
	if p := os.Getenv("LANDFLOW_TEST_PUBSUB_PROJECT"); p != "" {
		return p
	}
	return "landflow-dev"
}

func randomPrefix() string {
	b := make([]byte, 3)
	_, _ = rand.Read(b)
	return "lftest-" + hex.EncodeToString(b) + "-"
}

func testConfig(t *testing.T, prefix string) Config {
	t.Helper()
	// The shortest ack deadline Pub/Sub allows, so a crash case redelivers within the test; the client extends deadlines of running calls.
	return Config{Config: transport.Config{ConnectionID: "pubsub-test", Prefix: strings.TrimSuffix(prefix, "-")}, ProjectID: projectID(), EmulatorHost: emulatorHost(t), TopicPrefix: prefix, AckDeadline: 10 * time.Second}
}

func TestConfigFromURL(t *testing.T) {
	cfg, err := ConfigFromURL("pubsub-main", "pubsub://127.0.0.1:58085/landflow-dev", transport.ConnectionOptions{Prefix: "lf"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ProjectID != "landflow-dev" || cfg.EmulatorHost != "127.0.0.1:58085" || cfg.Prefix != "lf" || cfg.AllowCloud {
		t.Errorf("config = %+v", cfg)
	}
	if cfg, err := ConfigFromURL("c", "pubsub://127.0.0.1:58085/", transport.ConnectionOptions{Fields: map[string]string{"projectid": "other-proj", "topicprefix": "q-", "deadletter": "false"}}); err != nil || cfg.ProjectID != "other-proj" || cfg.TopicPrefix != "q-" || !cfg.NoDeadLetter {
		t.Errorf("fields = %+v %v", cfg, err)
	}
	if cfg, err := ConfigFromURL("c", "pubsub://landflow-dev", transport.ConnectionOptions{Fields: map[string]string{"emulatorhost": "pubsub:8085"}}); err != nil || cfg.EmulatorHost != "pubsub:8085" || cfg.ProjectID != "landflow-dev" {
		t.Errorf("project host = %+v %v", cfg, err)
	}
	// The guard against a real project: no emulator means an error unless allowcloud is set.
	for _, bad := range []struct {
		url  string
		opts transport.ConnectionOptions
	}{
		{"pubsub://landflow-dev", transport.ConnectionOptions{}},
		{"pubsub://pubsub.googleapis.com/landflow-dev", transport.ConnectionOptions{}},
		{"", transport.ConnectionOptions{Fields: map[string]string{"projectid": "landflow-dev"}}},
		{"kafka://x:1/p", transport.ConnectionOptions{}},
		{"pubsub://127.0.0.1:58085", transport.ConnectionOptions{}},
		{"pubsub://127.0.0.1:58085/Bad_Project", transport.ConnectionOptions{}},
		{"pubsub://127.0.0.1:58085/landflow-dev", transport.ConnectionOptions{Fields: map[string]string{"emulatorhost": "no-port"}}},
		{"pubsub://127.0.0.1:58085/landflow-dev", transport.ConnectionOptions{Fields: map[string]string{"maxmessagebytes": "20000000"}}},
	} {
		if _, err := ConfigFromURL("c", bad.url, bad.opts); err == nil {
			t.Errorf("%q %+v: want an error", bad.url, bad.opts.Fields)
		}
	}
	if cfg, err := ConfigFromURL("c", "pubsub://pubsub.googleapis.com/landflow-dev", transport.ConnectionOptions{Fields: map[string]string{"allowcloud": "true"}}); err != nil || !cfg.AllowCloud || cfg.EmulatorHost != "" || cfg.ProjectID != "landflow-dev" {
		t.Errorf("allowcloud = %+v %v", cfg, err)
	}
	if f, ok := transport.LookupDriver("pubsub"); !ok {
		t.Fatal("driver not registered")
	} else if drv, err := f("c", "pubsub://127.0.0.1:58085/landflow-dev", transport.ConnectionOptions{}); err != nil || drv.Kind() != Kind || !drv.Capabilities().Headers || !drv.Capabilities().OrderingKeys {
		t.Errorf("factory: %v", err)
	}
	// Connect refuses the real service before building a client.
	if err := New(Config{ProjectID: "landflow-dev"}).Connect(context.Background()); err == nil || !strings.Contains(err.Error(), "emulator host") {
		t.Errorf("connect without emulator: %v", err)
	}
	if err := New(Config{ProjectID: "landflow-dev", EmulatorHost: "pubsub.googleapis.com:443"}).Connect(context.Background()); err == nil || !strings.Contains(err.Error(), "real service") {
		t.Errorf("connect with the real host as emulator: %v", err)
	}
}

func TestResourceIDs(t *testing.T) {
	for in, want := range map[string]string{"landflow.v1.plugin.twilio": "landflow.v1.plugin.twilio", "1abc": "lf-1abc", "google.x": "lf-google.x", "ab": "ab_", "a/b": "a_b"} {
		if got := TopicID(in, ""); got != want {
			t.Errorf("TopicID(%q) = %q, want %q", in, got, want)
		}
	}
	if got := TopicID("landflow.v1.plugin.twilio", "lf-"); got != "lf-landflow.v1.plugin.twilio" {
		t.Errorf("prefixed topic id %q", got)
	}
	if got := SharedSubscriptionID("landflow.v1.plugin.twilio", "landflow.v1.plugin.twilio", ""); got != "landflow.v1.plugin.twilio" {
		t.Errorf("shared subscription id %q", got)
	}
	if got := SharedSubscriptionID("landflow.v1.plugin.twilio", "workers", ""); got != "landflow.v1.plugin.twilio.workers" {
		t.Errorf("group subscription id %q", got)
	}
}

func TestRoundTrip(t *testing.T) {
	prefix := randomPrefix()
	d := New(testConfig(t, prefix))
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if err := d.Connect(ctx); err != nil {
		t.Skipf("Pub/Sub emulator not reachable: %v", err)
	}
	names := transport.NewNames(strings.TrimSuffix(prefix, "-"))
	request, reply := names.Request("echo"), names.Reply("host-1")
	t.Cleanup(func() {
		cctx, ccancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer ccancel()
		_ = d.DeleteChannels(cctx, request, reply)
		_ = d.Close()
	})
	if err := d.Declare(ctx, []transport.ChannelSpec{transport.RequestSpec(request, 0), transport.ReplySpec(reply)}); err != nil {
		t.Fatal(err)
	}
	// Headers travel as ce_ attributes and come back bare; a second driver (a plugin's) publishes to the reply topic without declaring it.
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
	if _, err := other.Publish(ctx, reply, transport.WireEvent{Headers: map[string]string{"content-type": "application/json", "specversion": "1.0", "lfcorrelation": "c1"}, Body: []byte(`{"ok":true}`)}, transport.PublishOptions{}); err != nil {
		t.Fatal(err)
	}
	select {
	case e := <-got:
		if string(e.Body) != `{"ok":true}` || e.Headers["content-type"] != "application/json" || e.Headers["lfcorrelation"] != "c1" || e.Headers["specversion"] != "1.0" {
			t.Errorf("reply event: %+v", e)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("no reply delivered to the per-consumer subscription")
	}
	// Attempts come from delivery_attempt (dead-letter policy): a requeue is delivered again as attempt 2.
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
	if _, err := d.Publish(ctx, request, transport.WireEvent{Body: []byte("again")}, transport.PublishOptions{OrderingKey: "exec-1"}); err != nil {
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
}
