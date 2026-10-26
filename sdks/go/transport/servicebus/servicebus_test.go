package servicebus

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/landflow/landflow/sdks/go/transport"
)

const emulatorCS = "Endpoint=sb://127.0.0.1:55675;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;"

// target returns the connection string under test or skips (LANDFLOW_TEST_SERVICEBUS=sb://127.0.0.1:55675 or a connection string).
func target(t *testing.T) string {
	t.Helper()
	raw := os.Getenv("LANDFLOW_TEST_SERVICEBUS")
	if raw == "" {
		t.Skip("set LANDFLOW_TEST_SERVICEBUS=sb://127.0.0.1:55675 to run against the Service Bus emulator")
	}
	cfg, err := ConfigFromURL("test", raw, transport.ConnectionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return cfg.ConnectionString
}

func TestConfigFromURL(t *testing.T) {
	cfg, err := ConfigFromURL("sb-main", emulatorCS, transport.ConnectionOptions{Prefix: "lf"})
	if err != nil || cfg.ConnectionString != emulatorCS || !cfg.Emulator || cfg.Prefix != "lf" || cfg.ConnectionID != "sb-main" {
		t.Errorf("config = %+v %v", cfg, err)
	}
	real := "Endpoint=sb://acme.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=abc="
	if cfg, err := ConfigFromURL("sb", real, transport.ConnectionOptions{Fields: map[string]string{"maxmessagebytes": "1048576"}}); err != nil || cfg.ConnectionString != real+";" || cfg.Emulator || cfg.MaxMessageBytes != 1048576 {
		t.Errorf("real: %+v %v", cfg, err)
	}
	if cfg, err := ConfigFromURL("sb", "sb://acme.servicebus.windows.net", transport.ConnectionOptions{Username: "RootManageSharedAccessKey", Password: "k="}); err != nil || cfg.ConnectionString != "Endpoint=sb://acme.servicebus.windows.net;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=k=;" {
		t.Errorf("endpoint: %+v %v", cfg, err)
	}
	if cfg, err := ConfigFromURL("sb", "sb://127.0.0.1:55675", transport.ConnectionOptions{}); err != nil || cfg.ConnectionString != emulatorCS || !cfg.Emulator {
		t.Errorf("loopback: %+v %v", cfg, err)
	}
	if cfg, err := ConfigFromURL("sb", "sb://sb-emulator:5672", transport.ConnectionOptions{Fields: map[string]string{"emulator": "true"}}); err != nil || !cfg.Emulator {
		t.Errorf("emulator field: %+v %v", cfg, err)
	}
	if cfg, err := ConfigFromURL("sb", "Endpoint=sb://a;SharedAccessKeyName=n", transport.ConnectionOptions{Password: "secret"}); err != nil || cfg.ConnectionString != "Endpoint=sb://a;SharedAccessKeyName=n;SharedAccessKey=secret;" {
		t.Errorf("password: %+v %v", cfg, err)
	}
	for _, bad := range []string{"", "amqp://a:5672", "sb://acme.servicebus.windows.net", "Endpoint=https://a;SharedAccessKey=x", "Endpoint=sb://a;SharedAccessKeyName=n"} {
		if _, err := ConfigFromURL("c", bad, transport.ConnectionOptions{}); err == nil {
			t.Errorf("%q: want an error", bad)
		}
	}
	f, ok := transport.LookupDriver("servicebus")
	if !ok {
		t.Fatal("driver not registered")
	}
	drv, err := f("c", emulatorCS, transport.ConnectionOptions{})
	if err != nil || drv.Kind() != Kind || !drv.Capabilities().TTL || drv.Capabilities().Undeliverable != transport.UndeliverableUnknown || drv.Capabilities().MaxMessageBytes != DefaultMaxMessageBytes || drv.Capabilities().MaxHeaderBytes != DefaultMaxHeaderBytes {
		t.Errorf("factory: %v %+v", err, drv)
	}
}

func TestEntities(t *testing.T) {
	d := New(Config{ConnectionString: emulatorCS})
	c := d.ServiceBusConfig()
	if c.InstanceQueue != "landflow.v1.instance" || c.ReplyQueue != "landflow.v1.reply" || c.BroadcastTopic != "landflow.v1.broadcast" || len(c.BroadcastSubscriptions) != 16 || c.BroadcastSubscriptions[15] != "bc-15" || !c.Emulator || *c.CreateEntities {
		t.Errorf("defaults: %+v", c)
	}
	want := map[string]Entity{
		"landflow.v1.plugin.twilio":      {Kind: EntityQueue, Name: "landflow.v1.plugin.twilio"},
		"landflow.v1.instance.twilio.i1": {Kind: EntitySession, Name: "landflow.v1.instance", Session: "landflow.v1.instance.twilio.i1"},
		"landflow.v1.reply.h1":           {Kind: EntitySession, Name: "landflow.v1.reply", Session: "landflow.v1.reply.h1"},
		"landflow.v1.registry":           {Kind: EntityTopic, Name: "landflow.v1.broadcast"},
		"landflow.v1.control.twilio":     {Kind: EntityTopic, Name: "landflow.v1.broadcast"},
		"lfconf.1234.roundtrip":          {Kind: EntityQueue, Name: "lfconf.1234.roundtrip"},
	}
	for ch, e := range want {
		if got := d.EntityOf(ch); got != e {
			t.Errorf("%s: %+v", ch, got)
		}
	}
	mapped := New(Config{Config: transport.Config{Prefix: "acme"}, ConnectionString: emulatorCS, QueueFor: func(string) string { return "pool" }})
	if e := mapped.EntityOf("acme.v1.plugin.x"); e.Name != "pool" {
		t.Errorf("QueueFor ignored: %+v", e)
	}
	if e := mapped.EntityOf("acme.v1.reply.h"); e.Name != "acme.v1.reply" {
		t.Errorf("prefix ignored: %+v", e)
	}
	if isoDuration(60*time.Second) != "PT60S" || isoDuration(time.Millisecond) != "PT1S" {
		t.Error("isoDuration")
	}
}

func TestNotConnected(t *testing.T) {
	d := New(Config{ConnectionString: "Endpoint=sb://127.0.0.1:1;SharedAccessKeyName=n;SharedAccessKey=k;UseDevelopmentEmulator=true;"})
	if _, err := d.Publish(context.Background(), "x", transport.WireEvent{}, transport.PublishOptions{}); !transport.IsNotConnected(err) {
		t.Errorf("publish before connect: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
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

func TestMissingHintNamesTheScript(t *testing.T) {
	if got := missingHint(true, "landflow.v1.plugin.my-plugin"); !strings.Contains(got, "servicebus-config.py --plugin my-plugin,") {
		t.Fatalf("emulator plugin queue: %s", got)
	}
	if got := missingHint(true, "lfconf.roundtrip"); !strings.Contains(got, "servicebus-config.py --queue lfconf.roundtrip,") {
		t.Fatalf("emulator other queue: %s", got)
	}
	if got := missingHint(false, "landflow.v1.plugin.x"); !strings.Contains(got, "CreateEntities") {
		t.Fatalf("real namespace: %s", got)
	}
	cfg, err := ConfigFromURL("c", "Endpoint=sb://127.0.0.1:55675;SharedAccessKeyName=n;SharedAccessKey=k;UseDevelopmentEmulator=true;", transport.ConnectionOptions{Fields: map[string]string{"createentities": "true"}})
	if err != nil || cfg.CreateEntities == nil || !*cfg.CreateEntities {
		t.Fatalf("createentities field: %v %v", cfg.CreateEntities, err)
	}
}
