package landflow

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeBinding is a third face: it records its BindingContext, announces a
// logical endpoint, and runs one Execute through the dispatcher on demand.
type fakeBinding struct {
	kind     string
	failing  bool
	mu       sync.Mutex
	bc       BindingContext
	started  bool
	stopped  bool
	stopCtxs []context.Context
}

func (f *fakeBinding) Kind() string { return f.kind }

func (f *fakeBinding) Start(ctx context.Context, bc BindingContext) (BindingInfo, error) {
	if f.failing {
		return BindingInfo{}, fmt.Errorf("cannot connect to %s", f.kind)
	}
	f.mu.Lock()
	f.bc, f.started = bc, true
	f.mu.Unlock()
	return BindingInfo{Endpoints: []string{f.kind + "://conn-1/" + bc.Plugin.Info().ID}}, nil
}

func (f *fakeBinding) Stop(ctx context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stopped = true
	f.stopCtxs = append(f.stopCtxs, ctx)
	return nil
}

// deliver runs one call through the dispatcher the way a broker consumer would.
func (f *fakeBinding) deliver(req *ExecuteRequest, deadline time.Time) (*ExecuteResponse, error) {
	f.mu.Lock()
	bc := f.bc
	f.mu.Unlock()
	return bc.Dispatcher.Execute(context.Background(), req, CallOptions{Transport: f.kind, Deadline: deadline})
}

// announceCapture is an HTTP registry that records announces and withdraws.
func announceCapture(t *testing.T) (*httptest.Server, func() ([]AnnounceRequest, []WithdrawRequest)) {
	t.Helper()
	var mu sync.Mutex
	var announces []AnnounceRequest
	var withdraws []WithdrawRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		defer mu.Unlock()
		switch r.Method {
		case http.MethodPost:
			var req AnnounceRequest
			_ = json.Unmarshal(body, &req)
			announces = append(announces, req)
			_ = json.NewEncoder(w).Encode(AnnounceResponse{Accepted: true, HeartbeatIntervalSeconds: 10})
		case http.MethodDelete:
			var req WithdrawRequest
			_ = json.Unmarshal(body, &req)
			withdraws = append(withdraws, req)
			_, _ = w.Write([]byte(`{"ok":true}`))
		}
	}))
	t.Cleanup(srv.Close)
	return srv, func() ([]AnnounceRequest, []WithdrawRequest) {
		mu.Lock()
		defer mu.Unlock()
		return append([]AnnounceRequest(nil), announces...), append([]WithdrawRequest(nil), withdraws...)
	}
}

func TestServeWithThirdBinding(t *testing.T) {
	clearEnv(t)
	t.Setenv("LANDFLOW_TRANSPORTS", "")
	t.Setenv("LANDFLOW_MAX_CONCURRENCY", "")
	registry, captured := announceCapture(t)
	fake := &fakeBinding{kind: "fakebus"}
	p := testPlugin()
	httpPort := freePort(t)
	logs := &syncBuffer{}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- Serve(ctx, p, WithHTTP(httpPort), WithBinding(fake), WithMaxConcurrency(3), WithRegistryURL(registry.URL), WithLogger(log.New(logs, "", 0)))
	}()
	wantHTTP := "http://127.0.0.1:" + strconv.Itoa(httpPort)
	waitFor(t, "both endpoints announced", func() bool {
		anns, _ := captured()
		seen := map[string]bool{}
		for _, a := range anns {
			seen[a.Endpoint] = true
		}
		return seen[wantHTTP] && seen["fakebus://conn-1/test-plugin"]
	})

	// The binding got the shared dispatcher, the manifest with hints, and the hooks.
	fake.mu.Lock()
	bc := fake.bc
	fake.mu.Unlock()
	if bc.Dispatcher != p.Dispatcher() || bc.Dispatcher.MaxConcurrency() != 3 || bc.Plugin != p || bc.Logger == nil || bc.Telemetry == nil || bc.Announce == nil || bc.Fail == nil {
		t.Errorf("BindingContext = %+v", bc)
	}
	if strings.Join(bc.Manifest.Transports, ",") != "http,fakebus,mcp" || bc.Manifest.MaxConcurrency != 3 {
		t.Errorf("manifest hints = %v %d", bc.Manifest.Transports, bc.Manifest.MaxConcurrency)
	}
	// …and so did the manifest over HTTP and every announce.
	resp, err := http.Get(wantHTTP + PathManifest)
	if err != nil {
		t.Fatal(err)
	}
	var m PluginManifest
	_ = json.NewDecoder(resp.Body).Decode(&m)
	resp.Body.Close()
	if strings.Join(m.Transports, ",") != "http,fakebus,mcp" || m.MaxConcurrency != 3 {
		t.Errorf("manifest over HTTP: transports=%v maxConcurrency=%d", m.Transports, m.MaxConcurrency)
	}
	anns, _ := captured()
	for _, a := range anns {
		if strings.Join(a.Transports, ",") != "http,fakebus,mcp" || a.MaxConcurrency != 3 {
			t.Errorf("announce %s: transports=%v maxConcurrency=%d", a.Endpoint, a.Transports, a.MaxConcurrency)
		}
	}

	// A call delivered by the third binding runs through the same dispatcher, with its deadline.
	out, err := fake.deliver(execReq("test-plugin.upper", map[string]any{}, map[string]any{"value": "hi"}), time.Now().Add(time.Second))
	if err != nil || out.Error != nil || out.Outputs[0][0].JSON["value"] != "HI" {
		t.Errorf("deliver: %+v %v", out, err)
	}
	if _, err := fake.deliver(execReq("test-plugin.upper", map[string]any{}), time.Now().Add(-time.Second)); err == nil {
		t.Error("an expired deadline must not run the node")
	}
	// The announce hook registers late endpoints.
	bc.Announce("fakebus://conn-2/test-plugin")
	waitFor(t, "late endpoint announced", func() bool {
		anns, _ := captured()
		for _, a := range anns {
			if a.Endpoint == "fakebus://conn-2/test-plugin" {
				return true
			}
		}
		return false
	})

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Serve returned %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Serve did not return")
	}
	fake.mu.Lock()
	stopped := fake.stopped
	fake.mu.Unlock()
	if !stopped {
		t.Error("the binding was not stopped")
	}
	_, withdraws := captured()
	if len(withdraws) != 3 {
		t.Errorf("withdraws = %+v", withdraws)
	}
	if !strings.Contains(logs.String(), "over http, fakebus") || !strings.Contains(logs.String(), "max concurrency 3") {
		t.Errorf("logs:\n%s", logs)
	}
}

func TestServeBindingStartFailureStopsTheOthers(t *testing.T) {
	clearEnv(t)
	t.Setenv("LANDFLOW_TRANSPORTS", "")
	ok := &fakeBinding{kind: "okbus"}
	bad := &fakeBinding{kind: "badbus", failing: true}
	err := Serve(context.Background(), testPlugin(), WithBinding(ok), WithBinding(bad), WithAnnounce(false), WithLogger(log.New(io.Discard, "", 0)))
	if err == nil || !strings.Contains(err.Error(), "badbus") {
		t.Fatalf("Serve err = %v", err)
	}
	ok.mu.Lock()
	defer ok.mu.Unlock()
	if !ok.started || !ok.stopped {
		t.Errorf("okbus started=%v stopped=%v; the earlier binding must be stopped when a later one fails", ok.started, ok.stopped)
	}
}

func TestServeBindingFailAfterStartShutsDown(t *testing.T) {
	clearEnv(t)
	t.Setenv("LANDFLOW_TRANSPORTS", "")
	fake := &fakeBinding{kind: "fakebus"}
	done := make(chan error, 1)
	go func() {
		done <- Serve(context.Background(), testPlugin(), WithBinding(fake), WithAnnounce(false), WithLogger(log.New(io.Discard, "", 0)))
	}()
	waitFor(t, "binding started", func() bool {
		fake.mu.Lock()
		defer fake.mu.Unlock()
		return fake.started
	})
	fake.mu.Lock()
	fail := fake.bc.Fail
	fake.mu.Unlock()
	fail(fmt.Errorf("broker connection lost"))
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "broker connection lost") {
			t.Errorf("Serve err = %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Serve did not return after Fail")
	}
}

func TestTransportsEnvSelectsBindings(t *testing.T) {
	clearEnv(t)
	t.Setenv("LANDFLOW_MAX_CONCURRENCY", "")
	p := testPlugin()
	fake := &fakeBinding{kind: "fakebus"}

	t.Setenv("LANDFLOW_TRANSPORTS", "grpc, FAKEBUS ,nats")
	cfg, err := resolveConfig(p, ServeOptions{HTTPPort: 7420, GRPCPort: 7421, Bindings: []Binding{fake}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(cfg.transports, ",") != "grpc,fakebus" || cfg.httpPort != 0 || cfg.grpcPort != 7421 || len(cfg.bindings) != 2 {
		t.Errorf("filtered cfg: transports=%v http=%d grpc=%d bindings=%d", cfg.transports, cfg.httpPort, cfg.grpcPort, len(cfg.bindings))
	}
	if strings.Join(cfg.skipped, ",") != "nats" {
		t.Errorf("skipped = %v", cfg.skipped)
	}

	t.Setenv("LANDFLOW_TRANSPORTS", "mcp")
	if _, err := resolveConfig(p, ServeOptions{HTTPPort: 7420}); err == nil {
		t.Error("selecting only unconfigured kinds must fail with no transport enabled")
	}

	// The option form, overridden by the env.
	t.Setenv("LANDFLOW_TRANSPORTS", "")
	cfg, err = resolveConfig(p, ServeOptions{HTTPPort: 7420, GRPCPort: 7421, Transports: []string{"http"}})
	if err != nil || strings.Join(cfg.transports, ",") != "http" {
		t.Errorf("WithTransports cfg = %v %v", cfg.transports, err)
	}
	t.Setenv("LANDFLOW_TRANSPORTS", "grpc")
	cfg, _ = resolveConfig(p, ServeOptions{HTTPPort: 7420, GRPCPort: 7421, Transports: []string{"http"}})
	if strings.Join(cfg.transports, ",") != "grpc" {
		t.Errorf("env must beat WithTransports: %v", cfg.transports)
	}

	// Max concurrency: option, then env.
	t.Setenv("LANDFLOW_TRANSPORTS", "")
	cfg, _ = resolveConfig(p, ServeOptions{HTTPPort: 7420, MaxConcurrency: 4})
	if cfg.maxConcurrency != 4 {
		t.Errorf("maxConcurrency = %d", cfg.maxConcurrency)
	}
	t.Setenv("LANDFLOW_MAX_CONCURRENCY", "8")
	if cfg, _ = resolveConfig(p, ServeOptions{HTTPPort: 7420, MaxConcurrency: 4}); cfg.maxConcurrency != 8 {
		t.Errorf("env maxConcurrency = %d", cfg.maxConcurrency)
	}
	t.Setenv("LANDFLOW_MAX_CONCURRENCY", "-1")
	if _, err := resolveConfig(p, ServeOptions{HTTPPort: 7420}); err == nil {
		t.Error("expected invalid LANDFLOW_MAX_CONCURRENCY error")
	}
}

func TestServeOptionsMerge(t *testing.T) {
	var so ServeOptions
	fake := &fakeBinding{kind: "a"}
	for _, o := range []ServeOption{WithBinding(fake), ServeOptions{HTTPPort: 1, Bindings: []Binding{&fakeBinding{kind: "b"}}}, WithGRPC(2), WithTransports("http", "grpc")} {
		o.applyServe(&so)
	}
	if so.HTTPPort != 1 || so.GRPCPort != 2 || len(so.Bindings) != 2 || so.Bindings[0] != fake || len(so.Transports) != 2 {
		t.Errorf("merged options = %+v", so)
	}
	// Without Serve the manifest carries no hints, as before.
	p := testPlugin()
	if m := p.Manifest(); m.Transports != nil || m.MaxConcurrency != 0 {
		t.Errorf("manifest hints before Serve: %v %d", m.Transports, m.MaxConcurrency)
	}
	data, _ := json.Marshal(p.Manifest())
	if strings.Contains(string(data), "transports") || strings.Contains(string(data), "maxConcurrency") {
		t.Errorf("empty hints must be omitted: %s", data)
	}
	p.SetTransportHints([]string{"http"}, 2)
	if m := p.Manifest(); strings.Join(m.Transports, ",") != "http" || m.MaxConcurrency != 2 {
		t.Errorf("manifest hints after SetTransportHints: %v %d", m.Transports, m.MaxConcurrency)
	}
}
