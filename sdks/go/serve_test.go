package landflow

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/grpc"

	pb "github.com/landflow/landflow/sdks/go/landflowpb"
)

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func clearEnv(t *testing.T) {
	for _, k := range []string{"LANDFLOW_HTTP_PORT", "LANDFLOW_GRPC_PORT", "LANDFLOW_REGISTRY_URL", "LANDFLOW_ADVERTISE_HOST", "LANDFLOW_LISTEN_HOST"} {
		t.Setenv(k, "")
	}
}

func TestServeAnnouncesOverHTTPAndWithdraws(t *testing.T) {
	clearEnv(t)
	var mu sync.Mutex
	var announces []AnnounceRequest
	var withdraws []WithdrawRequest
	registry := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != AnnouncePath {
			http.NotFound(w, r)
			return
		}
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		defer mu.Unlock()
		switch r.Method {
		case http.MethodPost:
			var req AnnounceRequest
			_ = json.Unmarshal(body, &req)
			announces = append(announces, req)
			_ = json.NewEncoder(w).Encode(AnnounceResponse{Accepted: true, HeartbeatIntervalSeconds: 1})
		case http.MethodDelete:
			var req WithdrawRequest
			_ = json.Unmarshal(body, &req)
			withdraws = append(withdraws, req)
			_, _ = w.Write([]byte(`{"ok":true}`))
		}
	}))
	defer registry.Close()

	httpPort, grpcPort := freePort(t), freePort(t)
	t.Setenv("LANDFLOW_GRPC_PORT", strconv.Itoa(grpcPort)) // env beats options
	logs := &syncBuffer{}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- Serve(ctx, testPlugin(), ServeOptions{
			HTTPPort: httpPort, GRPCPort: 1, RegistryURL: registry.URL,
			Logger: log.New(logs, "", 0),
		})
	}()

	wantHTTP := "http://127.0.0.1:" + strconv.Itoa(httpPort)
	wantGRPC := "grpc://127.0.0.1:" + strconv.Itoa(grpcPort)
	count := func(ep string) int {
		mu.Lock()
		defer mu.Unlock()
		n := 0
		for _, a := range announces {
			if a.Endpoint == ep {
				n++
			}
		}
		return n
	}
	// Heartbeat interval 1s from the response → at least two announces each.
	waitFor(t, "heartbeats", func() bool { return count(wantHTTP) >= 2 && count(wantGRPC) >= 2 })

	mu.Lock()
	first := announces[0]
	mu.Unlock()
	if first.Protocol != ProtocolVersion || first.PluginID != "test-plugin" || first.Version != "1.2.3" || first.TTLSeconds != 30 {
		t.Errorf("announce = %+v", first)
	}
	resp, err := http.Get(wantHTTP + PathHealth)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("health over real listener: %v", err)
	}
	resp.Body.Close()

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Serve returned %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Serve did not return")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(withdraws) != 2 {
		t.Errorf("withdraws = %+v", withdraws)
	}
	if _, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(httpPort), 200*time.Millisecond); err == nil {
		t.Error("HTTP listener still open after Serve returned")
	}
	if !strings.Contains(logs.String(), "announced "+wantHTTP) || !strings.Contains(logs.String(), "withdrew "+wantHTTP) {
		t.Errorf("logs:\n%s", logs)
	}
}

func TestServeToleratesMissingRegistry(t *testing.T) {
	clearEnv(t)
	logs := &syncBuffer{}
	deadPort := freePort(t) // nothing listens here
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- Serve(ctx, testPlugin(), ServeOptions{
			HTTPPort: freePort(t), GRPCPort: freePort(t), RegistryURL: "http://127.0.0.1:" + strconv.Itoa(deadPort),
			Logger: log.New(logs, "", 0),
		})
	}()
	waitFor(t, "unreachable log", func() bool { return strings.Contains(logs.String(), "unreachable") })
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("Serve returned %v", err)
	}
	if n := strings.Count(logs.String(), "unreachable"); n != 1 {
		t.Errorf("unreachable logged %d times:\n%s", n, logs)
	}
	if strings.Contains(logs.String(), "withdr") {
		t.Errorf("must not withdraw endpoints that were never accepted:\n%s", logs)
	}
}

type fakeRegistry struct {
	pb.UnimplementedRegistryServiceServer
	mu        sync.Mutex
	announced []string
	withdrawn []string
}

func (f *fakeRegistry) Announce(_ context.Context, in *pb.AnnounceRequest) (*pb.AnnounceResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.announced = append(f.announced, in.GetEndpoint())
	return &pb.AnnounceResponse{Accepted: true, HeartbeatIntervalSeconds: 10}, nil
}

func (f *fakeRegistry) Withdraw(_ context.Context, in *pb.WithdrawRequest) (*pb.WithdrawResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.withdrawn = append(f.withdrawn, in.GetEndpoint())
	return &pb.WithdrawResponse{Ok: true}, nil
}

func TestServeAnnouncesOverGRPC(t *testing.T) {
	clearEnv(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	reg := &fakeRegistry{}
	srv := grpc.NewServer()
	pb.RegisterRegistryServiceServer(srv, reg)
	go func() { _ = srv.Serve(ln) }()
	defer srv.Stop()

	grpcPort := freePort(t)
	t.Setenv("LANDFLOW_REGISTRY_URL", "grpc://"+ln.Addr().String())
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- Serve(ctx, testPlugin(), ServeOptions{GRPCPort: grpcPort, Logger: log.New(io.Discard, "", 0)})
	}()
	want := "grpc://127.0.0.1:" + strconv.Itoa(grpcPort)
	waitFor(t, "grpc announce", func() bool {
		reg.mu.Lock()
		defer reg.mu.Unlock()
		return len(reg.announced) > 0
	})
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	reg.mu.Lock()
	defer reg.mu.Unlock()
	if reg.announced[0] != want || len(reg.withdrawn) != 1 || reg.withdrawn[0] != want {
		t.Errorf("announced=%v withdrawn=%v", reg.announced, reg.withdrawn)
	}
}

func TestServeConfig(t *testing.T) {
	clearEnv(t)
	p := testPlugin()
	off := false
	if _, err := resolveConfig(p, ServeOptions{}); err == nil {
		t.Error("expected error when no transport is enabled")
	}
	cfg, err := resolveConfig(p, ServeOptions{HTTPPort: 7100, Announce: &off})
	if err != nil || cfg.registryURL != "" || cfg.listenHost != "127.0.0.1" || cfg.advertiseHost != "127.0.0.1" {
		t.Errorf("cfg = %+v %v", cfg, err)
	}
	t.Setenv("LANDFLOW_REGISTRY_URL", "off")
	if cfg, _ := resolveConfig(p, ServeOptions{HTTPPort: 7100}); cfg.registryURL != "" {
		t.Error("LANDFLOW_REGISTRY_URL=off must disable announce")
	}
	t.Setenv("LANDFLOW_REGISTRY_URL", "")
	if cfg, _ := resolveConfig(p, ServeOptions{HTTPPort: 7100}); cfg.registryURL != DefaultRegistryURL {
		t.Errorf("default registry = %q", cfg.registryURL)
	}
	t.Setenv("LANDFLOW_ADVERTISE_HOST", "plugin.internal")
	t.Setenv("LANDFLOW_HTTP_PORT", "off")
	t.Setenv("LANDFLOW_GRPC_PORT", "7999")
	cfg, _ = resolveConfig(p, ServeOptions{HTTPPort: 7100})
	if cfg.httpPort != 0 || cfg.grpcPort != 7999 || cfg.listenHost != "" || cfg.advertiseHost != "plugin.internal" {
		t.Errorf("env cfg = %+v", cfg)
	}
	t.Setenv("LANDFLOW_GRPC_PORT", "abc")
	if _, err := resolveConfig(p, ServeOptions{HTTPPort: 7100}); err == nil {
		t.Error("expected invalid port error")
	}
	if _, err := newRegistryClient("ftp://x:1"); err == nil {
		t.Error("expected unsupported scheme error")
	}
}
