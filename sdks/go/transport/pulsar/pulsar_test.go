package pulsar

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/landflow/landflow/sdks/go/transport"
)

// broker returns the service URL under test or skips (LANDFLOW_TEST_PULSAR=pulsar://127.0.0.1:56650).
func broker(t *testing.T) string {
	t.Helper()
	u := os.Getenv("LANDFLOW_TEST_PULSAR")
	if u == "" {
		t.Skip("set LANDFLOW_TEST_PULSAR=pulsar://127.0.0.1:56650 to run against a Pulsar broker")
	}
	return u
}

// adminURL is the admin API under test (LANDFLOW_TEST_PULSAR_ADMIN, default http://127.0.0.1:58180).
func adminURL() string {
	if u := os.Getenv("LANDFLOW_TEST_PULSAR_ADMIN"); u != "" {
		return u
	}
	return "http://127.0.0.1:58180"
}

func TestConfigFromURL(t *testing.T) {
	cfg, err := ConfigFromURL("pulsar-main", "pulsar://a:6650/", transport.ConnectionOptions{Prefix: "lf", Password: "jwt", Fields: map[string]string{"adminurl": "http://a:8080/", "tenant": "acme", "namespace": "prod", "maxmessagebytes": "1024"}})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ServiceURL != "pulsar://a:6650" || cfg.AdminURL != "http://a:8080" || cfg.Tenant != "acme" || cfg.Namespace != "prod" || cfg.Token != "jwt" || cfg.Prefix != "lf" || cfg.ConnectionID != "pulsar-main" || cfg.MaxMessageBytes != 1024 {
		t.Errorf("config = %+v", cfg)
	}
	for in, want := range map[string]string{"pulsar://broker": "pulsar://broker:6650", "pulsar+ssl://broker": "pulsar+ssl://broker:6651", "pulsars://b:6651": "pulsar+ssl://b:6651", " pulsar://[::1]:6650 ": "pulsar://[::1]:6650"} {
		cfg, err := ConfigFromURL("c", in, transport.ConnectionOptions{})
		if err != nil || cfg.ServiceURL != want {
			t.Errorf("%q: %q %v", in, cfg.ServiceURL, err)
		}
	}
	if cfg, _ := ConfigFromURL("c", "pulsar://a:6650", transport.ConnectionOptions{TLS: true}); cfg.ServiceURL != "pulsar+ssl://a:6650" {
		t.Errorf("tls option ignored: %+v", cfg)
	}
	for _, bad := range []string{"", "kafka://a:9092", "pulsar://user:pw@a:6650", "pulsar://a:99999"} {
		if _, err := ConfigFromURL("c", bad, transport.ConnectionOptions{}); err == nil {
			t.Errorf("%q: want an error", bad)
		}
	}
	if _, err := ConfigFromURL("c", "pulsar://a:6650", transport.ConnectionOptions{Fields: map[string]string{"adminurl": "a:8080"}}); err == nil {
		t.Error("bad admin URL accepted")
	}
	if _, err := ConfigFromURL("c", "pulsar://a:6650", transport.ConnectionOptions{Fields: map[string]string{"tenant": "bad/tenant"}}); err == nil {
		t.Error("bad tenant accepted")
	}
	f, ok := transport.LookupDriver("pulsar")
	if !ok {
		t.Fatal("driver not registered")
	}
	drv, err := f("c", "pulsar://a:6650", transport.ConnectionOptions{})
	if err != nil || drv.Kind() != Kind || !drv.Capabilities().Nack || drv.Capabilities().TTL || drv.Capabilities().Undeliverable != transport.UndeliverableInferred {
		t.Errorf("factory: %v %+v", err, drv)
	}
	d := New(Config{})
	if d.TopicName("landflow.v1.plugin.x") != "persistent://public/default/landflow.v1.plugin.x" || d.PulsarConfig().MaxMessageBytes != DefaultMaxMessageBytes || d.Capabilities().MaxMessageBytes != DefaultMaxMessageBytes {
		t.Errorf("defaults: %+v", d.PulsarConfig())
	}
}

func TestNotConnected(t *testing.T) {
	d := New(Config{ServiceURL: "pulsar://127.0.0.1:1", ConnectTimeout: 2 * time.Second})
	if _, err := d.Publish(context.Background(), "x", transport.WireEvent{}, transport.PublishOptions{}); !transport.IsNotConnected(err) {
		t.Errorf("publish before connect: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := d.Connect(ctx); err == nil {
		t.Error("connect to a dead port succeeded")
	}
	if _, err := d.Publish(context.Background(), "x", transport.WireEvent{}, transport.PublishOptions{}); !transport.IsNotConnected(err) {
		t.Errorf("publish after a failed connect: %v", err)
	}
	if err := d.Close(); err != nil {
		t.Error(err)
	}
	if err := d.Close(); err != nil {
		t.Error(err)
	}
}
