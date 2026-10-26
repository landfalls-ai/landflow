package bridge_test

// The protocol conformance kit through the bridge over the in-memory broker (no containers): a Go plugin with no
// broker code reached over gRPC and over HTTP, and the Python conformance plugin (sdks/python/tests/conformance_plugin.py)
// reached over gRPC, each called from a Go transport.Client like the host. The tier 1 brokers are in ../live_test.go.
// Ports: stream T3-C's 7440–7459.

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/landflow/landflow/sdks/go/transport"
	"github.com/landflow/landflow/sdks/go/transport/memory"

	"github.com/landflow/landflow/services/landflow-bridge/bridge"
	"github.com/landflow/landflow/services/landflow-bridge/internal/kit"
)

const (
	goHTTPPort  = 7440
	goGRPCPort  = 7441
	pyHTTPPort  = 7442
	pyGRPCPort  = 7443
	pyHooksPort = 7444
	healthPort  = 7445
	secret      = "bridge-conformance-secret"
)

var keyring = transport.MustKeyring(secret)

func newBroker() *memory.Broker {
	return memory.NewBroker(memory.Options{Configure: func(c *transport.Capabilities) { c.MaxMessageBytes = 256 * 1024 }})
}

type deliveryLog struct {
	mu   sync.Mutex
	last *transport.DeliveryMode
}

func (d *deliveryLog) observe(_ transport.Method, dc transport.DispatchContext) {
	d.mu.Lock()
	defer d.mu.Unlock()
	mode := dc.Delivery
	d.last = &mode
}

func (d *deliveryLog) get() (transport.DeliveryMode, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.last == nil {
		return "", false
	}
	return *d.last, true
}

// startBridge runs a bridge over broker towards target and a client on the same broker, waiting for the announce.
func startBridge(t *testing.T, broker *memory.Broker, target string, extra func(*bridge.Config)) (*bridge.Bridge, *transport.Client, *deliveryLog) {
	t.Helper()
	ctx := context.Background()
	cfg := transport.Config{ConnectionID: "mem", Prefix: "lfbridge"}
	client, err := transport.StartClient(ctx, transport.ClientOptions{Driver: broker.Driver(cfg), Keyring: keyring, NoRegistryProof: true, Log: transport.SilentLogger, StatsInterval: -1})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	observed := &deliveryLog{}
	bcfg := bridge.Config{
		Target: target, Keyring: keyring, NoRegistryProof: true, AnnounceInterval: time.Minute, StartTimeout: 15 * time.Second,
		Drivers: []bridge.DriverFactory{{Kind: "memory", ConnectionID: "mem", New: func() (transport.Driver, error) { return broker.Driver(cfg), nil }}},
		Logger:  bridge.NewLogger(io.Discard, "info", "json"), Observe: observed.observe,
	}
	if extra != nil {
		extra(&bcfg)
	}
	b, err := bridge.New(bcfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := b.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = b.Stop(context.Background()) })
	for i := 0; i < 100; i++ {
		if p, ok := client.Plugin(kit.PluginID); ok && len(p.Instances) == 1 {
			return b, client, observed
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("the bridge's announce did not reach the client")
	return nil, nil, nil
}

func runKit(t *testing.T, broker *memory.Broker, target string, hooks kit.Hooks) {
	t.Helper()
	b, client, observed := startBridge(t, broker, target, nil)
	if got := b.PluginID(); got != kit.PluginID {
		t.Fatalf("plugin id %q", got)
	}
	announced, _ := client.Plugin(kit.PluginID)
	if announced.ManifestHash != b.ManifestHash() || announced.Instances[0].MaxConcurrency != 4 {
		t.Fatalf("announce %+v, bridge hash %s", announced, b.ManifestHash())
	}
	var manifest struct {
		Transports []string `json:"transports"`
	}
	_ = json.Unmarshal(b.Manifest(), &manifest)
	if !strings.Contains(strings.Join(manifest.Transports, ","), "memory") {
		t.Fatalf("served manifest transports %v should include the bridged kind", manifest.Transports)
	}
	kit.Run(t, kit.Options{
		Client: client, Hooks: hooks, LastDelivery: observed.get, Tap: func(fn func(string, transport.WireEvent) (transport.WireEvent, bool)) func() { return broker.Tap(fn) }, Manifest: b.Manifest(),
		Skip: map[string]string{"request-over-limit-with-store": "the claim-check store is not part of this wave"},
	})
}

func TestConformanceGoPluginOverGRPC(t *testing.T) {
	gp, stop, err := kit.ServeGoPlugin(context.Background(), goHTTPPort, goGRPCPort)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	runKit(t, newBroker(), "grpc://127.0.0.1:7441", gp.Hooks)
}

func TestConformanceGoPluginOverHTTP(t *testing.T) {
	gp, stop, err := kit.ServeGoPlugin(context.Background(), goHTTPPort, goGRPCPort)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	runKit(t, newBroker(), "http://127.0.0.1:7440", gp.Hooks)
}

func TestConformancePythonPluginOverGRPC(t *testing.T) {
	python := kit.PythonInterpreter()
	if python == "" {
		t.Skip("set LANDFLOW_TEST_PYTHON to a Python with grpcio (or create plugins/py-insights/.venv) to run the Python plugin through the bridge")
	}
	pp, err := kit.StartPythonPlugin(context.Background(), python, pyHTTPPort, pyGRPCPort, pyHooksPort)
	if err != nil {
		t.Fatal(err)
	}
	defer pp.Stop()
	runKit(t, newBroker(), "grpc://127.0.0.1:7443", pp.Hooks)
	if t.Failed() {
		t.Logf("python plugin output:\n%s", pp.Output.String())
	}
}

// A fake plugin over HTTP whose manifest can change: the bridge must re-read it and announce the new hash.
type fakePlugin struct {
	mu       sync.Mutex
	manifest map[string]any
	server   *httptest.Server
	// refuse makes the first refuse Execute calls answer 429 (0: never); executes counts them.
	refuse, executes int
}

func newFakePlugin() *fakePlugin {
	f := &fakePlugin{manifest: map[string]any{
		"protocol": "landflow.plugin/v1", "plugin": map[string]any{"id": "fake-plugin", "name": "Fake", "version": "1.0.0", "language": "none"},
		"nodes":          []any{map[string]any{"name": "n", "displayName": "N", "description": "", "version": 1, "kind": "action", "inputs": []any{}, "outputs": []any{}, "properties": []any{}}},
		"maxConcurrency": 2,
	}}
	mux := http.NewServeMux()
	mux.HandleFunc("/landflow/v1/manifest", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(f.manifest)
	})
	mux.HandleFunc("/landflow/v1/health", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"status":"ok","uptimeMs":1,"pluginId":"fake-plugin","version":"1.0.0"}`))
	})
	mux.HandleFunc("/landflow/v1/execute", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.executes++
		refuse := f.refuse > 0 && f.executes <= f.refuse
		f.mu.Unlock()
		if refuse {
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"error":{"message":"plugin at capacity"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"outputs":[[{"json":{"ok":true}}]]}`))
	})
	f.server = httptest.NewServer(mux)
	return f
}

func TestManifestChangeRestartsServers(t *testing.T) {
	fake := newFakePlugin()
	defer fake.server.Close()
	broker := newBroker()
	ctx := context.Background()
	cfg := transport.Config{ConnectionID: "mem", Prefix: "lfchange"}
	client, err := transport.StartClient(ctx, transport.ClientOptions{Driver: broker.Driver(cfg), Keyring: keyring, NoRegistryProof: true, Log: transport.SilentLogger, StatsInterval: -1})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	b, err := bridge.New(bridge.Config{
		Target: fake.server.URL, Keyring: keyring, NoRegistryProof: true, AnnounceInterval: time.Minute, ManifestPoll: 150 * time.Millisecond,
		HealthPort: healthPort, InstanceID: "inst-fixed",
		Drivers: []bridge.DriverFactory{{Kind: "memory", ConnectionID: "mem", New: func() (transport.Driver, error) { return broker.Driver(cfg), nil }}},
		Logger:  bridge.NewLogger(io.Discard, "info", "json"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := b.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer b.Stop(ctx)
	first := b.ManifestHash()
	if b.Servers()[0].MaxConcurrency() != 2 || b.InstanceID() != "inst-fixed" {
		t.Fatalf("prefetch %d, instance %s", b.Servers()[0].MaxConcurrency(), b.InstanceID())
	}
	// Health endpoint.
	resp, err := http.Get("http://127.0.0.1:7445/healthz")
	if err != nil {
		t.Fatal(err)
	}
	var report bridge.HealthReport
	_ = json.NewDecoder(resp.Body).Decode(&report)
	resp.Body.Close()
	if resp.StatusCode != 200 || report.Status != "ok" || report.PluginID != "fake-plugin" || len(report.Brokers) != 1 || report.Brokers[0].Endpoint != "memory://mem/fake-plugin" {
		t.Fatalf("health %d %+v", resp.StatusCode, report)
	}
	// A capacity refusal from the plugin (429 + Retry-After) is held and retried, never relayed as capacity: the broker
	// is the buffer the host spilled over to. Two refusals, then the call runs.
	execute := map[string]any{"protocol": "landflow.plugin/v1", "node": map[string]any{"type": "fake-plugin.n"}}
	fake.mu.Lock()
	fake.refuse, fake.executes = 2, 0
	fake.mu.Unlock()
	started := time.Now()
	reply, err := client.Call(ctx, "fake-plugin", transport.MethodExecute, execute, transport.CallOptions{Timeout: 6 * time.Second})
	if err != nil || !strings.Contains(string(reply), `"ok":true`) {
		t.Fatalf("held call: %v %s", err, reply)
	}
	fake.mu.Lock()
	executes := fake.executes
	fake.mu.Unlock()
	if executes != 3 || time.Since(started) < 2*time.Second {
		t.Fatalf("executes %d after %s, want 3 after two 1 s holds", executes, time.Since(started))
	}
	// Refused until the deadline: the host sees its deadline (expired), not capacity.
	fake.mu.Lock()
	fake.refuse, fake.executes = 1000, 0
	fake.mu.Unlock()
	_, err = client.Call(ctx, "fake-plugin", transport.MethodExecute, execute, transport.CallOptions{Timeout: 1500 * time.Millisecond})
	var timeout *transport.TimeoutError
	var remote *transport.RemoteError
	if asErr(err, &remote) && remote.RemoteCode == transport.CodeCapacity {
		t.Fatalf("capacity was relayed over the broker: %v", err)
	}
	if !asErr(err, &timeout) {
		t.Fatalf("want the deadline (expired), got %v", err)
	}
	fake.mu.Lock()
	executes = fake.executes
	fake.refuse = 0
	fake.mu.Unlock()
	if executes < 2 {
		t.Fatalf("the call was retried %d times, want at least 2", executes)
	}
	// Change the manifest: the bridge polls, restarts its servers on the new hash and announces it.
	fake.mu.Lock()
	fake.manifest["plugin"].(map[string]any)["version"] = "1.1.0"
	fake.mu.Unlock()
	deadline := time.Now().Add(5 * time.Second)
	for b.ManifestHash() == first {
		if time.Now().After(deadline) {
			t.Fatal("manifest hash did not change")
		}
		time.Sleep(50 * time.Millisecond)
	}
	for {
		p, ok := client.Plugin("fake-plugin")
		if ok && p.ManifestHash == b.ManifestHash() && p.Version == "1.1.0" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("client did not see the new hash: %+v", p)
		}
		time.Sleep(50 * time.Millisecond)
	}
	// A call that carries the old hash is answered manifest_mismatch, never run.
	_, err = client.Call(ctx, "fake-plugin", transport.MethodHealth, map[string]any{}, transport.CallOptions{Timeout: 3 * time.Second, ManifestHash: first})
	var mismatch *transport.ManifestMismatchError
	if !asErr(err, &mismatch) {
		t.Fatalf("want manifest_mismatch, got %v", err)
	}
	// Stop withdraws.
	if err := b.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 50; i++ {
		if p, ok := client.Plugin("fake-plugin"); !ok || len(p.Instances) == 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("the instance was not withdrawn")
}

func asErr[T error](err error, target *T) bool {
	for err != nil {
		if e, ok := err.(T); ok {
			*target = e
			return true
		}
		u, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}

func TestConfigAndEnv(t *testing.T) {
	kinds := bridge.BrokerKinds("http, grpc,Kafka,nats,kafka,mcp,")
	if strings.Join(kinds, ",") != "kafka,nats" {
		t.Fatalf("kinds %v", kinds)
	}
	env := map[string]string{
		bridge.EnvTarget: "grpc://127.0.0.1:7202", bridge.EnvTransports: "nats,http", bridge.EnvHealthPort: "7445", bridge.EnvManifestPoll: "5s",
		bridge.EnvMCP: "on", bridge.EnvMCPPort: "7446", bridge.EnvDrainTimeout: "1500",
	}
	cfg, err := bridge.ConfigFromEnv(func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Target != env[bridge.EnvTarget] || strings.Join(cfg.Kinds, ",") != "nats" || cfg.HealthPort != 7445 || cfg.ManifestPoll != 5*time.Second || cfg.MCP.Mode != "on" || cfg.MCP.Port != 7446 || cfg.DrainTimeout != 1500*time.Millisecond {
		t.Fatalf("config %+v", cfg)
	}
	// Without a target, a secret or a broker, New fails with a readable error.
	if _, err := bridge.New(bridge.Config{Getenv: func(string) string { return "" }}); err == nil || !strings.Contains(err.Error(), bridge.EnvTarget) {
		t.Fatalf("want target error, got %v", err)
	}
	if _, err := bridge.New(bridge.Config{Target: "grpc://127.0.0.1:1", Getenv: func(string) string { return "" }}); err == nil || !strings.Contains(err.Error(), transport.TransportSecretEnv) {
		t.Fatalf("want secret error, got %v", err)
	}
	if _, err := bridge.New(bridge.Config{Target: "grpc://127.0.0.1:1", Keyring: keyring, Kinds: []string{"nats"}, Getenv: func(string) string { return "" }}); err == nil || !strings.Contains(err.Error(), "LANDFLOW_NATS_URL") {
		t.Fatalf("want URL error, got %v", err)
	}
	// An env-driven driver: memory is registered by the memory package's init.
	factories, err := bridge.DriverFactoriesFromEnv([]string{"memory"}, func(k string) string {
		return map[string]string{"LANDFLOW_MEMORY_URL": "memory://default", "LANDFLOW_MEMORY_PREFIX": "p1"}[k]
	}, func() []string { return []string{"LANDFLOW_MEMORY_URL=memory://default"} })
	if err != nil {
		t.Fatal(err)
	}
	if len(factories) != 1 || factories[0].ConnectionID != "env-memory" {
		t.Fatalf("factories %+v", factories)
	}
	if _, err := bridge.NewTarget("ftp://x"); err == nil {
		t.Fatal("ftp accepted")
	}
	_ = os.Getenv
}
