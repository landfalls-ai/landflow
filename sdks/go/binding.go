package landflow

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"google.golang.org/grpc"
)

// Binding is one face of a plugin: a way calls reach the dispatcher. The SDK
// ships HTTP and gRPC; the messaging core (sdks/go/transport) adds one per
// broker and the MCP face is another. A binding converts its wire format to
// the protocol structs and calls the Dispatcher it was started with; it holds
// no node logic of its own.
//
// Serve starts bindings in order, announces the endpoints they return, and
// stops them in reverse order on shutdown. A binding that fails after Start
// reports it through BindingContext.Fail, which shuts the plugin down.
type Binding interface {
	// Kind names the transport: "http", "grpc", "mcp" or a broker kind
	// ("kafka", "amqp", "nats", "valkey"…). LANDFLOW_TRANSPORTS selects by it.
	Kind() string
	// Start listens or connects and returns the endpoints to announce (none
	// for a binding that announces itself, e.g. over a broker's registry
	// channel). It must return once the binding accepts calls.
	Start(ctx context.Context, bc BindingContext) (BindingInfo, error)
	// Stop drains in-flight calls and closes. ctx bounds the drain; when it
	// expires the binding closes hard.
	Stop(ctx context.Context) error
}

// BindingContext is what Serve hands every binding.
type BindingContext struct {
	Plugin     *Plugin
	Dispatcher *Dispatcher
	// Manifest is the plugin's manifest, with transports and maxConcurrency filled in.
	Manifest  PluginManifest
	Logger    *log.Logger
	Telemetry *Telemetry
	// ListenHost is the bind address ("" = all interfaces); AdvertiseHost the
	// host to put into announced endpoints.
	ListenHost    string
	AdvertiseHost string
	// Announce registers endpoints with the host registry after Start
	// returned (for a binding that learns them late, or gains one). Endpoints
	// returned from Start are announced by Serve itself. No-op when announce
	// is disabled.
	Announce func(endpoints ...string)
	// Fail reports a fatal failure after Start (the listener died, the broker
	// connection is gone for good). Serve logs it and shuts down.
	Fail func(err error)
}

// BindingInfo is what Start returns.
type BindingInfo struct {
	// Endpoints to announce to the registry: "http://host:port",
	// "grpc://host:port" or a logical "<kind>://<connectionId>/<pluginId>".
	Endpoints []string
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

// HTTPBinding serves the protocol's HTTP+JSON face (Dispatcher.Handler) on a
// TCP port. Serve builds one from WithHTTP / ServeOptions.HTTPPort / LANDFLOW_HTTP_PORT.
type HTTPBinding struct {
	// Port to listen on (0 = any free port; see Addr after Start).
	Port int
	// ReadHeaderTimeout for the server (default 10s).
	ReadHeaderTimeout time.Duration

	mu     sync.Mutex
	ln     net.Listener
	srv    *http.Server
	mounts map[string]http.Handler
}

// NewHTTPBinding returns an HTTP binding on port.
func NewHTTPBinding(port int) *HTTPBinding { return &HTTPBinding{Port: port} }

// Mount serves handler at path (and below) on the same port, next to the
// protocol paths; the MCP face mounts itself at /mcp this way. A nil handler
// removes the mount. Safe before and after Start.
func (b *HTTPBinding) Mount(path string, handler http.Handler) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.mounts == nil {
		b.mounts = map[string]http.Handler{}
	}
	if handler == nil {
		delete(b.mounts, path)
		return
	}
	b.mounts[path] = handler
}

// mounted returns the handler mounted at the request's path, if any.
func (b *HTTPBinding) mounted(path string) http.Handler {
	b.mu.Lock()
	defer b.mu.Unlock()
	for prefix, h := range b.mounts {
		if path == prefix || strings.HasPrefix(path, prefix+"/") {
			return h
		}
	}
	return nil
}

// Kind returns "http".
func (b *HTTPBinding) Kind() string { return "http" }

// Addr returns the listener address after Start (nil before).
func (b *HTTPBinding) Addr() net.Addr {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.ln == nil {
		return nil
	}
	return b.ln.Addr()
}

// Start binds the port and serves in the background.
func (b *HTTPBinding) Start(ctx context.Context, bc BindingContext) (BindingInfo, error) {
	ln, err := net.Listen("tcp", net.JoinHostPort(bc.ListenHost, strconv.Itoa(b.Port)))
	if err != nil {
		return BindingInfo{}, fmt.Errorf("landflow: listen HTTP: %w", err)
	}
	timeout := b.ReadHeaderTimeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	protocol := bc.Dispatcher.Handler()
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if h := b.mounted(r.URL.Path); h != nil {
			h.ServeHTTP(w, r)
			return
		}
		protocol.ServeHTTP(w, r)
	})
	srv := &http.Server{Handler: handler, ReadHeaderTimeout: timeout}
	b.mu.Lock()
	b.ln, b.srv = ln, srv
	b.mu.Unlock()
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) && bc.Fail != nil {
			bc.Fail(fmt.Errorf("landflow: HTTP server: %w", err))
		}
	}()
	return BindingInfo{Endpoints: []string{"http://" + net.JoinHostPort(bc.AdvertiseHost, strconv.Itoa(portOf(ln)))}}, nil
}

// Stop shuts the server down gracefully within ctx, then closes it.
func (b *HTTPBinding) Stop(ctx context.Context) error {
	b.mu.Lock()
	srv := b.srv
	b.srv, b.ln = nil, nil
	b.mu.Unlock()
	if srv == nil {
		return nil
	}
	if err := srv.Shutdown(ctx); err != nil {
		return srv.Close()
	}
	return nil
}

// ---------------------------------------------------------------------------
// gRPC
// ---------------------------------------------------------------------------

// GRPCBinding serves landflow.plugin.v1.PluginService on a TCP port. Serve
// builds one from WithGRPC / ServeOptions.GRPCPort / LANDFLOW_GRPC_PORT.
type GRPCBinding struct {
	// Port to listen on (0 = any free port; see Addr after Start).
	Port int
	// Options are passed to grpc.NewServer.
	Options []grpc.ServerOption

	mu  sync.Mutex
	ln  net.Listener
	srv *grpc.Server
}

// NewGRPCBinding returns a gRPC binding on port.
func NewGRPCBinding(port int, opts ...grpc.ServerOption) *GRPCBinding {
	return &GRPCBinding{Port: port, Options: opts}
}

// Kind returns "grpc".
func (b *GRPCBinding) Kind() string { return "grpc" }

// Addr returns the listener address after Start (nil before).
func (b *GRPCBinding) Addr() net.Addr {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.ln == nil {
		return nil
	}
	return b.ln.Addr()
}

// Start binds the port and serves in the background.
func (b *GRPCBinding) Start(ctx context.Context, bc BindingContext) (BindingInfo, error) {
	ln, err := net.Listen("tcp", net.JoinHostPort(bc.ListenHost, strconv.Itoa(b.Port)))
	if err != nil {
		return BindingInfo{}, fmt.Errorf("landflow: listen gRPC: %w", err)
	}
	srv := grpc.NewServer(b.Options...)
	bc.Dispatcher.RegisterGRPC(srv)
	b.mu.Lock()
	b.ln, b.srv = ln, srv
	b.mu.Unlock()
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, grpc.ErrServerStopped) && bc.Fail != nil {
			bc.Fail(fmt.Errorf("landflow: gRPC server: %w", err))
		}
	}()
	return BindingInfo{Endpoints: []string{"grpc://" + net.JoinHostPort(bc.AdvertiseHost, strconv.Itoa(portOf(ln)))}}, nil
}

// Stop stops the server gracefully within ctx, then hard.
func (b *GRPCBinding) Stop(ctx context.Context) error {
	b.mu.Lock()
	srv := b.srv
	b.srv, b.ln = nil, nil
	b.mu.Unlock()
	if srv == nil {
		return nil
	}
	stopped := make(chan struct{})
	go func() { srv.GracefulStop(); close(stopped) }()
	select {
	case <-stopped:
	case <-ctx.Done():
		srv.Stop()
	}
	return nil
}

// Both ship as Bindings.
var (
	_ Binding = (*HTTPBinding)(nil)
	_ Binding = (*GRPCBinding)(nil)
)
