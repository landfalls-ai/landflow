package main

// The protocol conformance kit through the bridge over the tier 1 brokers, gated on LANDFLOW_TEST_<KIND>
// (skipped cleanly without them): a Python plugin (sdks/python/tests/conformance_plugin.py) and a Go plugin with no
// broker code, each reached over gRPC, called from a Go transport.Client like the host.
//
//	LANDFLOW_TEST_KAFKA=127.0.0.1:59092 LANDFLOW_TEST_AMQP=amqp://landflow:landflow-dev-only@127.0.0.1:55672 \
//	LANDFLOW_TEST_NATS=nats://127.0.0.1:54222 LANDFLOW_TEST_VALKEY=redis://127.0.0.1:56379 go test . -run Live -v
//
// Ports: stream T3-C's 7446–7450. The tampered-event cases need a tap and are skipped on real brokers; the brokers
// keep their 1 MiB default limit, so the over-limit cases pad to 1 MiB as the kit says.

import (
	"context"
	"io"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/landflow/landflow/sdks/go/transport"
	"github.com/landflow/landflow/sdks/go/transport/amqp"

	"github.com/landflow/landflow/services/landflow-bridge/bridge"
	"github.com/landflow/landflow/services/landflow-bridge/internal/kit"
)

const liveSecret = "bridge-live-secret"

// liveKinds maps each kind to the LANDFLOW_TEST_* variable and how its value becomes LANDFLOW_<KIND>_URL.
var liveKinds = []struct {
	kind, env string
	url       func(v string) string
}{
	{"kafka", "LANDFLOW_TEST_KAFKA", func(v string) string {
		if strings.Contains(v, "://") {
			return v
		}
		return "kafka://" + v
	}},
	{"amqp", "LANDFLOW_TEST_AMQP", func(v string) string { return v }},
	{"nats", "LANDFLOW_TEST_NATS", func(v string) string { return v }},
	{"jetstream", "LANDFLOW_TEST_NATS", func(v string) string { return v }},
	{"valkey", "LANDFLOW_TEST_VALKEY", func(v string) string { return v }},
}

type liveObserver struct {
	mu   sync.Mutex
	last *transport.DeliveryMode
}

func (o *liveObserver) observe(_ transport.Method, dc transport.DispatchContext) {
	o.mu.Lock()
	defer o.mu.Unlock()
	m := dc.Delivery
	o.last = &m
}

func (o *liveObserver) get() (transport.DeliveryMode, bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.last == nil {
		return "", false
	}
	return *o.last, true
}

func runLive(t *testing.T, kind, url, target string, hooks kit.Hooks) {
	t.Helper()
	ctx := context.Background()
	prefix := "lfbridge" + strings.ReplaceAll(time.Now().Format("150405.000"), ".", "")
	factory, ok := transport.LookupDriver(kind)
	if !ok {
		t.Fatalf("no %s driver registered", kind)
	}
	opts := transport.ConnectionOptions{Prefix: prefix, Fields: map[string]string{}}
	if kind == "kafka" {
		opts.Fields["mode"] = "group" // Kafka 4.2 share groups are not enabled on the dev broker
	}
	build := func(id string) (transport.Driver, error) {
		if kind == "amqp" {
			// RabbitMQ accepts 16 MiB by default; the kit's over-limit cases pad to 1 MiB, so set the connection's limit
			// there (the host does the same through the connection's maxMessageBytes field).
			cfg, err := amqp.ConfigFromURL(id, url, opts)
			if err != nil {
				return nil, err
			}
			cfg.MaxMessageBytes = 1 << 20
			return amqp.New(cfg), nil
		}
		return factory(id, url, opts)
	}
	newDriver := func(id string) transport.Driver {
		d, err := build(id)
		if err != nil {
			t.Fatal(err)
		}
		return d
	}
	keyring := transport.MustKeyring(liveSecret)
	client, err := transport.StartClient(ctx, transport.ClientOptions{Driver: newDriver("host-" + kind), Keyring: keyring, NoRegistryProof: true, Log: transport.SilentLogger, StatsInterval: -1})
	if err != nil {
		t.Fatalf("client: %v", err)
	}
	defer client.Close()
	observed := &liveObserver{}
	b, err := bridge.New(bridge.Config{
		Target: target, Keyring: keyring, NoRegistryProof: true, AnnounceInterval: 2 * time.Second, StartTimeout: 15 * time.Second,
		Drivers: []bridge.DriverFactory{{Kind: kind, ConnectionID: "env-" + kind, New: func() (transport.Driver, error) { return build("env-" + kind) }}},
		Logger:  bridge.NewLogger(io.Discard, "info", "json"), Observe: observed.observe,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := b.Start(ctx); err != nil {
		t.Fatalf("bridge start: %v", err)
	}
	defer b.Stop(ctx)
	deadline := time.Now().Add(15 * time.Second)
	for {
		if p, ok := client.Plugin(kit.PluginID); ok && len(p.Instances) >= 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the bridge's announce did not reach the client")
		}
		time.Sleep(50 * time.Millisecond)
	}
	skip := map[string]string{"request-over-limit-with-store": "the claim-check store is not part of this wave"}
	if kind == "valkey" || kind == "kafka" || kind == "jetstream" {
		// These brokers buffer: a cancel that arrives before its request is consumed is honoured, but the four blockers
		// plus the race on a shared dev broker make the case flaky; the memory run covers it deterministically.
		skip["cancel-before-dispatch"] = "covered over the in-memory broker; racy on a buffering broker shared with other tests"
	}
	kit.Run(t, kit.Options{Client: client, Hooks: hooks, LastDelivery: observed.get, Manifest: b.Manifest(), Skip: skip, Settle: 800 * time.Millisecond})
}

func TestLiveBrokers(t *testing.T) {
	var selected []struct{ kind, url string }
	for _, k := range liveKinds {
		if v := strings.TrimSpace(os.Getenv(k.env)); v != "" {
			selected = append(selected, struct{ kind, url string }{k.kind, k.url(v)})
		}
	}
	if len(selected) == 0 {
		t.Skip("set LANDFLOW_TEST_KAFKA / LANDFLOW_TEST_AMQP / LANDFLOW_TEST_NATS / LANDFLOW_TEST_VALKEY to run the kit through the bridge over the brokers")
	}
	ctx := context.Background()
	gp, stopGo, err := kit.ServeGoPlugin(ctx, 7446, 7447)
	if err != nil {
		t.Fatal(err)
	}
	defer stopGo()
	var py *kit.PythonPlugin
	if python := kit.PythonInterpreter(); python != "" {
		if py, err = kit.StartPythonPlugin(ctx, python, 7448, 7449, 7450); err != nil {
			t.Fatal(err)
		}
		defer py.Stop()
	}
	for _, s := range selected {
		s := s
		t.Run(s.kind+"/go-plugin", func(t *testing.T) { runLive(t, s.kind, s.url, "grpc://127.0.0.1:7447", gp.Hooks) })
		t.Run(s.kind+"/python-plugin", func(t *testing.T) {
			if py == nil {
				t.Skip("no Python interpreter with grpcio (LANDFLOW_TEST_PYTHON)")
			}
			runLive(t, s.kind, s.url, "grpc://127.0.0.1:7449", py.Hooks)
		})
	}
}
