package bridge

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/landflow/landflow/sdks/go/mcpface"
)

// The bridge's MCP face (docs/transports.md "MCP: every plugin is also an MCP server"): the Go MCP face
// (sdks/go/mcpface, stream D) over the manifest the bridge serves, with tools/call forwarded to the plugin through the
// same dispatcher the brokers use. Streamable HTTP at /mcp (both protocol eras, from the go-sdk), on
// LANDFLOW_MCP_HOST:LANDFLOW_MCP_PORT with LANDFLOW_MCP_TOKEN as the bearer token; LANDFLOW_MCP_CREDENTIALS binds
// credentials by type (mcpface.LoadCredentialsFromEnv). Off by default: an SDK that launches the bridge serves its
// own face; turn it on for a plugin whose SDK has none.

// mcpServer is the running MCP face; the handler follows the manifest (refresh swaps the face).
type mcpServer struct {
	addr   string
	server *http.Server
	face   atomic.Pointer[mcpface.Face]
}

// startMCP applies LANDFLOW_MCP (on | off) and the token rule: loopback without a token is fine, a non-loopback host
// without LANDFLOW_MCP_TOKEN stays off with an error line. It returns the stop function (never nil).
func (b *Bridge) startMCP(_ context.Context) func(context.Context) {
	noop := func(context.Context) {}
	switch strings.ToLower(strings.TrimSpace(b.cfg.MCP.Mode)) {
	case "", "off", "false", "0", "no":
		return noop
	}
	host := b.cfg.MCP.Host
	if host == "" {
		host = DefaultHealthHost
	}
	loopback := isLoopback(host)
	if !loopback && b.cfg.MCP.Token == "" {
		b.log.Error("MCP face not started: "+EnvMCPHost+" is not loopback and "+EnvMCPToken+" is not set", "host", host, "port", b.cfg.MCP.Port)
		return noop
	}
	if b.cfg.MCP.Port <= 0 {
		b.log.Error("MCP face not started: set " + EnvMCPPort)
		return noop
	}
	face, err := b.newFace(loopback)
	if err != nil {
		b.log.Error("MCP face not started", "error", err.Error())
		return noop
	}
	ln, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(b.cfg.MCP.Port)))
	if err != nil {
		b.log.Error("MCP face not started", "error", err.Error())
		return noop
	}
	srv := &mcpServer{addr: ln.Addr().String()}
	srv.face.Store(face)
	mux := http.NewServeMux()
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { srv.face.Load().Handler().ServeHTTP(w, r) })
	mux.Handle("/mcp", handler)
	mux.Handle("/mcp/", handler)
	srv.server = &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = srv.server.Serve(ln) }()
	b.mu.Lock()
	b.mcp = srv
	b.mu.Unlock()
	b.log.Info("MCP face serving", "url", fmt.Sprintf("http://%s/mcp", srv.addr), "tools", len(face.Tools()), "token", b.cfg.MCP.Token != "")
	return func(ctx context.Context) {
		_ = srv.server.Shutdown(ctx)
		b.mu.Lock()
		b.mcp = nil
		b.mu.Unlock()
	}
}

func (b *Bridge) newFace(loopback bool) (*mcpface.Face, error) {
	return mcpface.New(b.Manifest(), b.dispatch, mcpface.FaceOptions{Token: b.cfg.MCP.Token, Loopback: loopback, Logger: b.log.With("face", "mcp")})
}

// refreshMCP rebuilds the face after a manifest change, so tools/list follows the plugin.
func (b *Bridge) refreshMCP() {
	b.mu.Lock()
	srv := b.mcp
	b.mu.Unlock()
	if srv == nil {
		return
	}
	face, err := b.newFace(srv.face.Load() != nil && isLoopbackAddr(srv.addr))
	if err != nil {
		b.log.Error("MCP face not refreshed", "error", err.Error())
		return
	}
	srv.face.Store(face)
}

// MCPAddr is the MCP face's listen address ("" when off).
func (b *Bridge) MCPAddr() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.mcp == nil {
		return ""
	}
	return b.mcp.addr
}

func isLoopbackAddr(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	return err == nil && isLoopback(host)
}

func isLoopback(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}
