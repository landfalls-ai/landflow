package landflow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync"

	"github.com/landflow/landflow/sdks/go/mcpface"
	"github.com/landflow/landflow/sdks/go/transport"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// MCPOptions configures the plugin's own MCP face (docs/protocol.md §15.2):
// Streamable HTTP at /mcp on the HTTP port by default, or stdio. The
// environment wins over these fields: LANDFLOW_MCP (on | off | stdio), the
// --mcp-stdio flag, LANDFLOW_MCP_TOKEN and LANDFLOW_MCP_CREDENTIALS.
type MCPOptions struct {
	// Enabled false turns the face off (LANDFLOW_MCP=stdio still wins).
	Enabled *bool
	// Stdio speaks MCP on stdin/stdout and nothing else (no HTTP, no announce; logs to stderr).
	Stdio bool
	// Token is required as `Authorization: Bearer` on /mcp unless the HTTP
	// server listens on loopback only. Default LANDFLOW_MCP_TOKEN. Without one
	// on a non-loopback host the face stays off and an error line says so.
	Token string
	// Credentials by local credential type name for the tools (default:
	// LANDFLOW_MCP_CREDENTIALS, a JSON file path or inline JSON).
	Credentials mcpface.Credentials
	// Path on the HTTP port (default /mcp).
	Path string
}

// WithMCP configures the MCP face; the default (no call) is on at /mcp.
func WithMCP(o MCPOptions) ServeOption {
	return serveOptionFunc(func(so *ServeOptions) { so.MCP = &o })
}

// WithoutMCP turns the plugin's MCP face off (LANDFLOW_MCP=stdio still wins).
func WithoutMCP() ServeOption {
	off := false
	return serveOptionFunc(func(so *ServeOptions) { so.MCP = &MCPOptions{Enabled: &off} })
}

// mcpMode resolves the face's mode from the flag, the environment and the options.
func mcpMode(o *MCPOptions) (mcpface.Mode, error) {
	fallback := mcpface.ModeHTTP
	if o != nil {
		if o.Enabled != nil && !*o.Enabled {
			fallback = mcpface.ModeOff
		} else if o.Stdio {
			fallback = mcpface.ModeStdio
		}
	}
	return mcpface.ModeFromEnv(fallback, nil, nil)
}

// MCPBinding mounts the MCP face at /mcp on the HTTP binding; Serve builds one
// unless the face is off. Kind is "mcp", so LANDFLOW_TRANSPORTS selects it.
type MCPBinding struct {
	// HTTP is the binding to mount on (Serve sets it; nil = the face cannot start).
	HTTP    *HTTPBinding
	Options MCPOptions

	mu   sync.Mutex
	face *mcpface.Face
	path string
}

// NewMCPBinding returns an MCP binding over the HTTP binding.
func NewMCPBinding(httpBinding *HTTPBinding, o MCPOptions) *MCPBinding {
	return &MCPBinding{HTTP: httpBinding, Options: o}
}

// Kind returns "mcp".
func (b *MCPBinding) Kind() string { return "mcp" }

// Face returns the face after Start (nil before).
func (b *MCPBinding) Face() *mcpface.Face {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.face
}

// Start builds the face over the plugin's dispatcher and mounts it. A missing
// token on a non-loopback host is not fatal: the face stays off and an error
// line says so, the plugin keeps serving its other faces.
func (b *MCPBinding) Start(ctx context.Context, bc BindingContext) (BindingInfo, error) {
	if b.HTTP == nil {
		bc.Logger.Printf("MCP face not started: it needs the HTTP binding (set an HTTP port, or use --mcp-stdio)")
		return BindingInfo{}, nil
	}
	token := firstNonEmpty(b.Options.Token, os.Getenv(mcpface.TokenEnv))
	loopback := mcpface.IsLoopbackHost(bc.ListenHost)
	if token == "" && !loopback {
		bc.Logger.Printf("MCP face not started: %s is not set and the HTTP server listens on %s (not loopback only); set a token or LANDFLOW_LISTEN_HOST=127.0.0.1",
			mcpface.TokenEnv, orDefault(bc.ListenHost, "all interfaces"))
		return BindingInfo{}, nil
	}
	face, err := newMCPFace(bc, b.Options, token, loopback)
	if err != nil {
		return BindingInfo{}, err
	}
	path := firstNonEmpty(b.Options.Path, PathMCP)
	b.HTTP.Mount(path, face.Handler())
	b.mu.Lock()
	b.face, b.path = face, path
	b.mu.Unlock()
	if loopback && token == "" {
		bc.Logger.Printf("MCP face at %s (loopback only, no token)", path)
	} else {
		bc.Logger.Printf("MCP face at %s (Bearer token required)", path)
	}
	return BindingInfo{}, nil
}

// Stop unmounts the face; calls in flight finish with the HTTP server's drain.
func (b *MCPBinding) Stop(ctx context.Context) error {
	b.mu.Lock()
	face, path := b.face, b.path
	b.face = nil
	b.mu.Unlock()
	if face != nil && b.HTTP != nil {
		b.HTTP.Mount(path, nil)
	}
	return nil
}

// newMCPFace builds the face over the binding context's dispatcher.
func newMCPFace(bc BindingContext, o MCPOptions, token string, loopback bool) (*mcpface.Face, error) {
	creds := o.Credentials
	if creds == nil {
		var err error
		if creds, err = mcpface.LoadCredentialsFromEnv(); err != nil {
			return nil, fmt.Errorf("landflow: MCP face: %w", err)
		}
	}
	var logger *slog.Logger
	if bc.Telemetry != nil {
		logger = slog.New(bc.Telemetry.logHandler)
	}
	dispatch := func(ctx context.Context, method transport.Method, body json.RawMessage, dc transport.DispatchContext) (any, error) {
		opts := CallOptions{Transport: "mcp", Deadline: dc.Deadline}
		if name := mcpface.ToolNameOf(ctx); name != "" {
			opts.Attributes = Attrs{"mcp.tool.name": name}
		}
		if bc.Telemetry != nil && dc.TraceParent != "" {
			ctx = bc.Telemetry.extractTraceParent(ctx, dc.TraceParent, dc.TraceState)
		}
		return dispatchLocal(ctx, bc.Dispatcher, method, body, opts)
	}
	return mcpface.New(bc.Manifest, dispatch, mcpface.FaceOptions{Credentials: creds, Token: token, Loopback: loopback, Logger: logger})
}

// mcpStdioTransport is the transport of stdio mode: the process's stdin/stdout (tests swap in pipes).
var mcpStdioTransport = func() mcp.Transport { return &mcp.StdioTransport{} }

// serveMCPStdio is Serve in stdio mode: the plugin speaks MCP on stdin/stdout
// and nothing else; the process log goes to stderr.
func serveMCPStdio(ctx context.Context, p *Plugin, so ServeOptions, cfg serveConfig, tel *Telemetry) error {
	o := MCPOptions{}
	if so.MCP != nil {
		o = *so.MCP
	}
	p.SetTransportHints([]string{"mcp"}, cfg.maxConcurrency)
	dispatcher := NewDispatcher(p, DispatcherOptions{MaxConcurrency: cfg.maxConcurrency, MaxQueue: cfg.maxQueue})
	p.dispatcher.Store(dispatcher)
	bc := BindingContext{Plugin: p, Dispatcher: dispatcher, Manifest: p.Manifest(), Logger: cfg.logger, Telemetry: tel, ListenHost: "127.0.0.1", AdvertiseHost: cfg.advertiseHost}
	face, err := newMCPFace(bc, o, "", true)
	if err != nil {
		return err
	}
	cfg.logger.Printf("%s %s speaking MCP on stdio (%d tool(s)); no other face, no announce", p.info.ID, p.info.Version, len(face.Tools()))
	err = face.ServeTransport(ctx, mcpStdioTransport())
	if err != nil && (errors.Is(err, context.Canceled) || strings.Contains(err.Error(), "EOF")) {
		err = nil
	}
	drainCtx, cancel := context.WithTimeout(context.Background(), cfg.shutdownTimeout)
	defer cancel()
	_ = dispatcher.Drain(drainCtx)
	cfg.logger.Printf("stopped")
	return err
}
