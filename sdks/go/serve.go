package landflow

import (
	"context"
	"errors"
	"fmt"
	"log"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"google.golang.org/grpc"
)

// ServeOptions configures Serve. Environment variables take precedence over
// the values given here so operators can relocate a plugin without rebuilding:
//
//	LANDFLOW_HTTP_PORT / LANDFLOW_GRPC_PORT  listen ports ("off" disables)
//	LANDFLOW_TRANSPORTS                      comma-separated binding kinds to run (http,grpc,kafka,…);
//	                                         unset = every configured binding
//	LANDFLOW_MAX_CONCURRENCY                 calls one instance takes at once (0 = unlimited)
//	LANDFLOW_REGISTRY_URL                    http(s)://… | grpc://… | off (default http://127.0.0.1:3000)
//	LANDFLOW_ADVERTISE_HOST                  host put into announced endpoints (default 127.0.0.1)
//	LANDFLOW_LISTEN_HOST                     bind address (default: loopback when the advertise
//	                                         host is loopback, all interfaces otherwise)
//
// Telemetry follows the OTEL_* and LANDFLOW_LOG_* / LANDFLOW_METRICS_PROMETHEUS
// variables of docs/observability.md (see TelemetryOptions).
//
// ServeOptions is itself a ServeOption, so both forms work:
//
//	landflow.Serve(ctx, p, landflow.ServeOptions{HTTPPort: 7104, GRPCPort: 7204})
//	landflow.Serve(ctx, p, landflow.WithHTTP(7104), landflow.WithGRPC(7204), landflow.WithBinding(b))
type ServeOptions struct {
	// HTTPPort / GRPCPort: 0 disables the transport unless the env var sets it.
	HTTPPort int
	GRPCPort int
	// Bindings are further faces of the plugin (broker bindings from
	// sdks/go/transport, the MCP face, your own). They start after HTTP and gRPC.
	Bindings []Binding
	// Transports limits the bindings that run to these kinds (like
	// LANDFLOW_TRANSPORTS, which overrides it). Empty = all configured.
	Transports []string
	// MaxConcurrency bounds the calls one instance runs at once (0 =
	// unlimited); LANDFLOW_MAX_CONCURRENCY overrides it. Announced in the
	// manifest as maxConcurrency.
	MaxConcurrency int
	// MaxQueue bounds the calls waiting for a slot before new ones are refused
	// with ErrOverloaded (0 = MaxConcurrency, NoQueue = refuse at once).
	MaxQueue int
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

// ServeOption configures Serve: a ServeOptions struct or one of the With…
// functions. Several may be combined; later ones win, Bindings accumulate.
type ServeOption interface {
	applyServe(*ServeOptions)
}

// applyServe merges a whole ServeOptions: set fields replace, Bindings append.
func (o ServeOptions) applyServe(dst *ServeOptions) {
	bindings := append(append([]Binding(nil), dst.Bindings...), o.Bindings...)
	*dst = o
	dst.Bindings = bindings
}

type serveOptionFunc func(*ServeOptions)

func (f serveOptionFunc) applyServe(o *ServeOptions) { f(o) }

// WithHTTP serves the HTTP+JSON face on port (LANDFLOW_HTTP_PORT overrides).
func WithHTTP(port int) ServeOption {
	return serveOptionFunc(func(o *ServeOptions) { o.HTTPPort = port })
}

// WithGRPC serves the gRPC face on port (LANDFLOW_GRPC_PORT overrides).
func WithGRPC(port int) ServeOption {
	return serveOptionFunc(func(o *ServeOptions) { o.GRPCPort = port })
}

// WithBinding adds a binding (a broker driver's binding, the MCP face, your own).
func WithBinding(b Binding) ServeOption {
	return serveOptionFunc(func(o *ServeOptions) { o.Bindings = append(o.Bindings, b) })
}

// WithMaxConcurrency bounds the calls one instance runs at once (0 = unlimited).
func WithMaxConcurrency(n int) ServeOption {
	return serveOptionFunc(func(o *ServeOptions) { o.MaxConcurrency = n })
}

// WithMaxQueue bounds the calls waiting for a slot (0 = MaxConcurrency, NoQueue = none).
func WithMaxQueue(n int) ServeOption {
	return serveOptionFunc(func(o *ServeOptions) { o.MaxQueue = n })
}

// WithTransports limits the bindings that run to these kinds, like LANDFLOW_TRANSPORTS.
func WithTransports(kinds ...string) ServeOption {
	return serveOptionFunc(func(o *ServeOptions) { o.Transports = kinds })
}

// WithAnnounce turns registry announcement on or off (default on).
func WithAnnounce(on bool) ServeOption {
	return serveOptionFunc(func(o *ServeOptions) { o.Announce = &on })
}

// WithRegistryURL overrides LANDFLOW_REGISTRY_URL.
func WithRegistryURL(url string) ServeOption {
	return serveOptionFunc(func(o *ServeOptions) { o.RegistryURL = url })
}

// WithLogger sets the lifecycle logger.
func WithLogger(l *log.Logger) ServeOption {
	return serveOptionFunc(func(o *ServeOptions) { o.Logger = l })
}

// WithGRPCOptions passes options to grpc.NewServer.
func WithGRPCOptions(opts ...grpc.ServerOption) ServeOption {
	return serveOptionFunc(func(o *ServeOptions) { o.GRPCOptions = append(o.GRPCOptions, opts...) })
}

type serveConfig struct {
	httpPort, grpcPort int
	bindings           []Binding // every binding to run, in start order
	transports         []string  // the kinds of bindings
	maxConcurrency     int
	maxQueue           int
	listenHost         string
	advertiseHost      string
	registryURL        string // "" = announce disabled
	ttl                int
	shutdownTimeout    time.Duration
	logger             *log.Logger
	skipped            []string // kinds LANDFLOW_TRANSPORTS named that have no binding
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
	if cfg.maxConcurrency, err = maxConcurrencyFromEnv(opts.MaxConcurrency); err != nil {
		return cfg, err
	}
	cfg.maxQueue = opts.MaxQueue

	// Every configured binding, HTTP and gRPC first; then the LANDFLOW_TRANSPORTS filter.
	var configured []Binding
	if cfg.httpPort > 0 {
		configured = append(configured, NewHTTPBinding(cfg.httpPort))
	}
	if cfg.grpcPort > 0 {
		configured = append(configured, NewGRPCBinding(cfg.grpcPort, opts.GRPCOptions...))
	}
	for i, b := range opts.Bindings {
		if b == nil {
			return cfg, fmt.Errorf("landflow: Bindings[%d] is nil", i)
		}
		configured = append(configured, b)
	}
	selected := transportsFromEnv(opts.Transports)
	if selected == nil {
		cfg.bindings = configured
	} else {
		have := map[string]bool{}
		for _, b := range configured {
			have[b.Kind()] = true
		}
		// Broker bindings from the environment: LANDFLOW_TRANSPORTS=…,kafka + LANDFLOW_KAFKA_URL (messaging.go).
		fromEnv, err := brokerBindingsFromEnv(selected, have)
		if err != nil {
			return cfg, err
		}
		configured = append(configured, fromEnv...)
		for _, b := range configured {
			if selected[b.Kind()] {
				cfg.bindings = append(cfg.bindings, b)
			}
			have[b.Kind()] = true
		}
		for kind := range selected {
			if !have[kind] {
				cfg.skipped = append(cfg.skipped, kind)
			}
		}
	}
	cfg.httpPort, cfg.grpcPort = 0, 0
	for _, b := range cfg.bindings {
		cfg.transports = append(cfg.transports, b.Kind())
		switch hb := b.(type) {
		case *HTTPBinding:
			cfg.httpPort = hb.Port
		case *GRPCBinding:
			cfg.grpcPort = hb.Port
		}
	}
	if len(cfg.bindings) == 0 {
		return cfg, errors.New("landflow: no transport enabled; set ServeOptions.HTTPPort/GRPCPort, WithBinding, or LANDFLOW_HTTP_PORT/LANDFLOW_GRPC_PORT (and check LANDFLOW_TRANSPORTS)")
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

// transportsFromEnv returns the set of kinds LANDFLOW_TRANSPORTS (or the
// option) selects, nil when neither is set.
func transportsFromEnv(fromOptions []string) map[string]bool {
	raw := strings.TrimSpace(os.Getenv("LANDFLOW_TRANSPORTS"))
	var kinds []string
	switch {
	case raw != "":
		kinds = strings.Split(raw, ",")
	case len(fromOptions) > 0:
		kinds = fromOptions
	default:
		return nil
	}
	set := map[string]bool{}
	for _, k := range kinds {
		if k = strings.ToLower(strings.TrimSpace(k)); k != "" {
			set[k] = true
		}
	}
	return set
}

// Serve starts the plugin's bindings (HTTP and/or gRPC, plus any given with
// WithBinding), announces each endpoint to the host registry and heartbeats
// until ctx is cancelled or SIGINT/SIGTERM arrives. It then withdraws the
// endpoints, stops the bindings gracefully (in reverse order) and returns
// nil. It returns an error if a binding cannot start or fails.
func Serve(ctx context.Context, p *Plugin, opts ...ServeOption) error {
	if p == nil {
		return errors.New("landflow: Serve called with a nil plugin")
	}
	var so ServeOptions
	for _, o := range opts {
		if o != nil {
			o.applyServe(&so)
		}
	}
	cfg, err := resolveConfig(p, so)
	if err != nil {
		return err
	}
	tel := p.telemetry.Load()
	if tel == nil {
		topts := so.Telemetry
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
	for _, kind := range cfg.skipped {
		logger.Printf("LANDFLOW_TRANSPORTS names %q but no such binding is configured; ignored", kind)
	}

	// The dispatcher every binding shares, and the manifest hints the host reads.
	p.SetTransportHints(cfg.transports, cfg.maxConcurrency)
	dispatcher := NewDispatcher(p, DispatcherOptions{MaxConcurrency: cfg.maxConcurrency, MaxQueue: cfg.maxQueue})
	p.dispatcher.Store(dispatcher)

	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	// The announcer is created before the bindings start so a binding can announce from Start.
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
				transports: cfg.transports, maxConcurrency: cfg.maxConcurrency,
			}
		}
	} else {
		logger.Printf("announce disabled (LANDFLOW_REGISTRY_URL=off or ServeOptions.Announce=false)")
	}
	announceEndpoints := func(endpoints ...string) {
		if ann != nil && len(endpoints) > 0 {
			ann.start(annCtx, endpoints)
		}
	}

	bindingErr := make(chan error, len(cfg.bindings)+1)
	bc := BindingContext{
		Plugin: p, Dispatcher: dispatcher, Manifest: p.Manifest(), Logger: logger, Telemetry: tel,
		ListenHost: cfg.listenHost, AdvertiseHost: cfg.advertiseHost,
		Announce: announceEndpoints,
		Fail: func(err error) {
			select {
			case bindingErr <- err:
			default:
			}
		},
	}

	// Start in order so a port clash fails fast, before anything is announced.
	var started []Binding
	var endpoints []string
	stopBindings := func(timeout time.Duration) {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		for i := len(started) - 1; i >= 0; i-- {
			if err := started[i].Stop(shutdownCtx); err != nil {
				logger.Printf("stop %s binding: %v", started[i].Kind(), err)
			}
		}
	}
	for _, b := range cfg.bindings {
		info, err := b.Start(ctx, bc)
		if err != nil {
			stopBindings(cfg.shutdownTimeout)
			return fmt.Errorf("landflow: start %s binding: %w", b.Kind(), err)
		}
		started = append(started, b)
		endpoints = append(endpoints, info.Endpoints...)
	}
	logger.Printf("%s %s serving %d node(s) over %s on %s (listening on %s)",
		p.info.ID, p.info.Version, len(p.order), strings.Join(cfg.transports, ", "),
		orDefault(strings.Join(endpoints, ", "), "no announced endpoint"), orDefault(cfg.listenHost, "all interfaces"))
	if cfg.maxConcurrency > 0 {
		logger.Printf("max concurrency %d", cfg.maxConcurrency)
	}
	if tel.MetricsHandler() != nil && cfg.httpPort > 0 {
		for _, b := range started {
			if hb, ok := b.(*HTTPBinding); ok && hb.Addr() != nil {
				logger.Printf("metrics at http://%s%s", net.JoinHostPort(cfg.advertiseHost, strconv.Itoa(hb.Addr().(*net.TCPAddr).Port)), PathMetrics)
			}
		}
	}
	announceEndpoints(endpoints...)

	var runErr error
	select {
	case <-ctx.Done():
		logger.Printf("shutting down (%v)", context.Cause(ctx))
	case runErr = <-bindingErr:
		logger.Printf("%v; shutting down", runErr)
	}
	stop() // a second signal now kills the process the default way

	cancelAnn()
	if ann != nil {
		ann.withdraw(3 * time.Second)
	}
	stopBindings(cfg.shutdownTimeout)
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
