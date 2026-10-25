package landflow

import (
	"context"
	"errors"
	"fmt"
	"log"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"google.golang.org/grpc"
)

// ServeOptions configures Serve. Environment variables take precedence over
// the ports given here so operators can relocate a plugin without rebuilding:
//
//	LANDFLOW_HTTP_PORT / LANDFLOW_GRPC_PORT  listen ports ("off" disables)
//	LANDFLOW_REGISTRY_URL                    http(s)://… | grpc://… | off (default http://127.0.0.1:3000)
//	LANDFLOW_ADVERTISE_HOST                  host put into announced endpoints (default 127.0.0.1)
//	LANDFLOW_LISTEN_HOST                     bind address (default: loopback when the advertise
//	                                         host is loopback, all interfaces otherwise)
//
// Telemetry follows the OTEL_* and LANDFLOW_LOG_* / LANDFLOW_METRICS_PROMETHEUS
// variables of docs/observability.md (see TelemetryOptions).
type ServeOptions struct {
	// HTTPPort / GRPCPort: 0 disables the transport unless the env var sets it.
	HTTPPort int
	GRPCPort int
	// Announce: nil or true announces to the registry; false disables it.
	// LANDFLOW_REGISTRY_URL=off disables it as well.
	Announce *bool

	// Optional overrides of the corresponding environment variables.
	RegistryURL   string
	AdvertiseHost string
	ListenHost    string
	// TTLSeconds is the requested lease (default 30).
	TTLSeconds int
	// ShutdownTimeout bounds graceful shutdown (default 10s).
	ShutdownTimeout time.Duration
	// Logger receives lifecycle messages (default: the structured process
	// log on stdout, see Telemetry.Logger).
	Logger *log.Logger
	// GRPCOptions are passed to grpc.NewServer.
	GRPCOptions []grpc.ServerOption
	// Telemetry configures traces, metrics and logs unless
	// Plugin.SetupTelemetry was called before Serve.
	Telemetry TelemetryOptions
}

type serveConfig struct {
	httpPort, grpcPort int
	listenHost         string
	advertiseHost      string
	registryURL        string // "" = announce disabled
	ttl                int
	shutdownTimeout    time.Duration
	logger             *log.Logger
}

func resolveConfig(p *Plugin, opts ServeOptions) (serveConfig, error) {
	cfg := serveConfig{httpPort: opts.HTTPPort, grpcPort: opts.GRPCPort}
	var err error
	if cfg.httpPort, err = portFromEnv("LANDFLOW_HTTP_PORT", cfg.httpPort); err != nil {
		return cfg, err
	}
	if cfg.grpcPort, err = portFromEnv("LANDFLOW_GRPC_PORT", cfg.grpcPort); err != nil {
		return cfg, err
	}
	if cfg.httpPort <= 0 && cfg.grpcPort <= 0 {
		return cfg, errors.New("landflow: no transport enabled; set ServeOptions.HTTPPort/GRPCPort or LANDFLOW_HTTP_PORT/LANDFLOW_GRPC_PORT")
	}

	cfg.advertiseHost = firstNonEmpty(opts.AdvertiseHost, os.Getenv("LANDFLOW_ADVERTISE_HOST"), "127.0.0.1")
	cfg.listenHost = firstNonEmpty(opts.ListenHost, os.Getenv("LANDFLOW_LISTEN_HOST"))
	if cfg.listenHost == "" && isLoopback(cfg.advertiseHost) {
		cfg.listenHost = "127.0.0.1"
	}

	registry := firstNonEmpty(opts.RegistryURL, os.Getenv("LANDFLOW_REGISTRY_URL"), DefaultRegistryURL)
	announce := opts.Announce == nil || *opts.Announce
	if announce && !strings.EqualFold(strings.TrimSpace(registry), "off") {
		cfg.registryURL = strings.TrimSpace(registry)
	}

	cfg.ttl = opts.TTLSeconds
	if cfg.ttl <= 0 {
		cfg.ttl = DefaultAnnounceTTLSeconds
	}
	cfg.shutdownTimeout = opts.ShutdownTimeout
	if cfg.shutdownTimeout <= 0 {
		cfg.shutdownTimeout = 10 * time.Second
	}
	cfg.logger = opts.Logger // nil: the telemetry logger, set in Serve
	return cfg, nil
}

// Serve starts the HTTP and/or gRPC servers, announces each endpoint to the
// host registry and heartbeats until ctx is cancelled or SIGINT/SIGTERM
// arrives. It then withdraws the endpoints, gracefully stops both servers and
// returns nil. It returns an error if a server cannot start or fails.
func Serve(ctx context.Context, p *Plugin, opts ServeOptions) error {
	if p == nil {
		return errors.New("landflow: Serve called with a nil plugin")
	}
	cfg, err := resolveConfig(p, opts)
	if err != nil {
		return err
	}
	tel := p.telemetry.Load()
	if tel == nil {
		topts := opts.Telemetry
		topts.Global = true
		if tel, err = p.SetupTelemetry(ctx, topts); err != nil {
			return fmt.Errorf("landflow: telemetry: %w", err)
		}
		defer func() {
			flushCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = tel.Shutdown(flushCtx)
			p.telemetry.CompareAndSwap(tel, nil)
		}()
	}
	if cfg.logger == nil {
		cfg.logger = slog.NewLogLogger(tel.logHandler, slog.LevelInfo)
	}
	logger := cfg.logger

	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Bind first so a port clash fails fast, before anything is announced.
	var httpLn, grpcLn net.Listener
	closeAll := func() {
		if httpLn != nil {
			_ = httpLn.Close()
		}
		if grpcLn != nil {
			_ = grpcLn.Close()
		}
	}
	if cfg.httpPort > 0 {
		if httpLn, err = net.Listen("tcp", net.JoinHostPort(cfg.listenHost, strconv.Itoa(cfg.httpPort))); err != nil {
			return fmt.Errorf("landflow: listen HTTP: %w", err)
		}
	}
	if cfg.grpcPort > 0 {
		if grpcLn, err = net.Listen("tcp", net.JoinHostPort(cfg.listenHost, strconv.Itoa(cfg.grpcPort))); err != nil {
			closeAll()
			return fmt.Errorf("landflow: listen gRPC: %w", err)
		}
	}

	serverErr := make(chan error, 2)
	var httpSrv *http.Server
	var grpcSrv *grpc.Server
	var endpoints []string

	if httpLn != nil {
		httpSrv = &http.Server{Handler: p.Handler(), ReadHeaderTimeout: 10 * time.Second}
		go func() {
			if err := httpSrv.Serve(httpLn); err != nil && !errors.Is(err, http.ErrServerClosed) {
				serverErr <- fmt.Errorf("landflow: HTTP server: %w", err)
			}
		}()
		endpoints = append(endpoints, "http://"+net.JoinHostPort(cfg.advertiseHost, strconv.Itoa(portOf(httpLn))))
	}
	if grpcLn != nil {
		grpcSrv = p.GRPCServer(opts.GRPCOptions...)
		go func() {
			if err := grpcSrv.Serve(grpcLn); err != nil && !errors.Is(err, grpc.ErrServerStopped) {
				serverErr <- fmt.Errorf("landflow: gRPC server: %w", err)
			}
		}()
		endpoints = append(endpoints, "grpc://"+net.JoinHostPort(cfg.advertiseHost, strconv.Itoa(portOf(grpcLn))))
	}
	logger.Printf("%s %s serving %d node(s) on %s (listening on %s)",
		p.info.ID, p.info.Version, len(p.order), strings.Join(endpoints, ", "), orDefault(cfg.listenHost, "all interfaces"))
	if tel.MetricsHandler() != nil && httpLn != nil {
		logger.Printf("metrics at http://%s%s", net.JoinHostPort(cfg.advertiseHost, strconv.Itoa(portOf(httpLn))), PathMetrics)
	}

	var ann *announcer
	annCtx, cancelAnn := context.WithCancel(ctx)
	defer cancelAnn()
	if cfg.registryURL != "" {
		client, err := newRegistryClient(cfg.registryURL)
		if err != nil {
			logger.Printf("announce disabled: %v", err)
		} else {
			ann = &announcer{
				client: client, pluginID: p.info.ID, version: p.info.Version,
				ttlSeconds: cfg.ttl, logger: logger, announced: map[string]bool{},
			}
			ann.start(annCtx, endpoints)
		}
	} else {
		logger.Printf("announce disabled (LANDFLOW_REGISTRY_URL=off or ServeOptions.Announce=false)")
	}

	var runErr error
	select {
	case <-ctx.Done():
		logger.Printf("shutting down (%v)", context.Cause(ctx))
	case runErr = <-serverErr:
		logger.Printf("%v; shutting down", runErr)
	}
	stop() // a second signal now kills the process the default way

	cancelAnn()
	if ann != nil {
		ann.withdraw(3 * time.Second)
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.shutdownTimeout)
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		if httpSrv != nil {
			if err := httpSrv.Shutdown(shutdownCtx); err != nil {
				_ = httpSrv.Close()
			}
		}
		if grpcSrv != nil {
			stopped := make(chan struct{})
			go func() { grpcSrv.GracefulStop(); close(stopped) }()
			select {
			case <-stopped:
			case <-shutdownCtx.Done():
				grpcSrv.Stop()
			}
		}
	}()
	<-done
	logger.Printf("stopped")
	return runErr
}

func portFromEnv(name string, fallback int) (int, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	switch {
	case raw == "":
		return fallback, nil
	case strings.EqualFold(raw, "off"):
		return 0, nil
	}
	port, err := strconv.Atoi(raw)
	if err != nil || port < 0 || port > 65535 {
		return 0, fmt.Errorf("landflow: %s=%q is not a valid port", name, raw)
	}
	return port, nil
}

func portOf(ln net.Listener) int {
	if addr, ok := ln.Addr().(*net.TCPAddr); ok {
		return addr.Port
	}
	return 0
}

func isLoopback(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
