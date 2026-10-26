// Package bridge is landflow-bridge: a sidecar that sits next to any plugin speaking landflow.plugin/v1 over
// HTTP or gRPC (built with any SDK, or none) and serves it over every broker the Go messaging core has a driver
// for (docs/transports.md "How each language gets every broker"; docs/protocol.md §14).
//
// It fetches the target plugin's manifest, starts one transport.Server per broker connection with the plugin's own
// id, version and manifest hash (so the host sees the plugin itself, not the bridge), forwards each brokered call to
// the plugin over gRPC (preferred) or HTTP with the deadline, the cancellation and the error codes mapped, announces
// on the broker's registry channel with the registry proof, re-reads the manifest when it changes, serves a health
// endpoint and drains on stop.
package bridge

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/landflow/landflow/sdks/go/transport"
)

// Environment variables (the same names the Go SDK uses where they overlap).
const (
	EnvTarget       = "LANDFLOW_BRIDGE_TARGET"        // grpc://127.0.0.1:7202 | http://127.0.0.1:7102 (required)
	EnvTransports   = "LANDFLOW_TRANSPORTS"           // comma-separated broker kinds to serve; empty = every kind with a URL
	EnvInstanceID   = "LANDFLOW_BRIDGE_INSTANCE_ID"   // the plugin's own instance id, so its endpoints merge on the host
	EnvHealthPort   = "LANDFLOW_BRIDGE_HEALTH_PORT"   // GET /healthz; 0 or empty = off
	EnvHealthHost   = "LANDFLOW_BRIDGE_HEALTH_HOST"   // default 127.0.0.1
	EnvManifestPoll = "LANDFLOW_BRIDGE_MANIFEST_POLL" // how often the manifest hash is re-read (default 30s)
	EnvDrainTimeout = "LANDFLOW_BRIDGE_DRAIN_TIMEOUT" // how long Stop waits for calls in flight (default 30s)
	EnvStartTimeout = "LANDFLOW_BRIDGE_START_TIMEOUT" // how long Start waits for the target's manifest (default 60s)
	EnvMaxConc      = "LANDFLOW_MAX_CONCURRENCY"      // overrides the manifest's maxConcurrency
	EnvMCP          = "LANDFLOW_MCP"                  // on | off (default off in the bridge)
	EnvMCPPort      = "LANDFLOW_MCP_PORT"
	EnvMCPHost      = "LANDFLOW_MCP_HOST"
	EnvMCPToken     = "LANDFLOW_MCP_TOKEN"
	EnvLogLevel     = "LANDFLOW_LOG_LEVEL"
	EnvLogFormat    = "LANDFLOW_LOG_FORMAT"
)

// Defaults.
const (
	DefaultManifestPoll = 30 * time.Second
	DefaultDrainTimeout = 30 * time.Second
	DefaultStartTimeout = 60 * time.Second
	DefaultHealthHost   = "127.0.0.1"
)

// DriverFactory builds a fresh, unconnected driver for one broker connection. The bridge connects it when it starts
// a server and closes it when the server stops; a manifest change rebuilds the servers, so it is called again.
type DriverFactory struct {
	Kind         string
	ConnectionID string
	New          func() (transport.Driver, error)
}

// MCPConfig is the bridge's MCP face (stream D's Go MCP face, once it exists; see mcp.go).
type MCPConfig struct {
	// Mode is "on" or "off" (default off: an SDK that launches the bridge serves its own MCP face).
	Mode  string
	Host  string
	Port  int
	Token string
}

// Config configures a Bridge. ConfigFromEnv fills it from the environment; tests set the fields directly.
type Config struct {
	// Target is the plugin: grpc://host:port or http://host:port.
	Target string
	// Kinds are the broker kinds to serve (LANDFLOW_TRANSPORTS without http, grpc and mcp). Empty with no Drivers:
	// every registered kind that has a LANDFLOW_<KIND>_URL.
	Kinds []string
	// Drivers, when set, replace the environment-driven drivers (tests, embedding).
	Drivers []DriverFactory
	// Keyring signs and encrypts (default transport.KeyringFromEnv).
	Keyring *transport.Keyring
	// RegistrySecret proves announces (default LANDFLOW_REGISTRY_SECRET through the core).
	RegistrySecret string
	// NoRegistryProof announces without a proof (tests).
	NoRegistryProof bool
	// InstanceID is the plugin's instance id (default: random per process).
	InstanceID string
	// MaxConcurrency overrides the manifest's maxConcurrency (0 = the manifest's, else 16).
	MaxConcurrency int
	ManifestPoll   time.Duration
	DrainTimeout   time.Duration
	StartTimeout   time.Duration
	// AnnounceInterval is the heartbeat (default 10 s).
	AnnounceInterval time.Duration
	HealthHost       string
	HealthPort       int
	MCP              MCPConfig
	Logger           *slog.Logger
	// Observe sees every dispatched call (tests: the delivery mode the core chose).
	Observe func(method transport.Method, dc transport.DispatchContext)
	// Getenv and Environ default to the process environment.
	Getenv  func(string) string
	Environ func() []string
}

func (c *Config) getenv(name string) string {
	if c.Getenv != nil {
		return strings.TrimSpace(c.Getenv(name))
	}
	return strings.TrimSpace(os.Getenv(name))
}

func (c *Config) environ() []string {
	if c.Environ != nil {
		return c.Environ()
	}
	return os.Environ()
}

// ConfigFromEnv reads the bridge's configuration from the environment (getenv nil = os.Getenv). It does not validate
// the target; New does.
func ConfigFromEnv(getenv func(string) string) (Config, error) {
	cfg := Config{Getenv: getenv}
	cfg.Target = cfg.getenv(EnvTarget)
	cfg.Kinds = BrokerKinds(cfg.getenv(EnvTransports))
	cfg.InstanceID = cfg.getenv(EnvInstanceID)
	cfg.HealthHost = cfg.getenv(EnvHealthHost)
	var err error
	if cfg.HealthPort, err = envInt(cfg.getenv(EnvHealthPort), EnvHealthPort); err != nil {
		return cfg, err
	}
	if cfg.MaxConcurrency, err = envInt(cfg.getenv(EnvMaxConc), EnvMaxConc); err != nil {
		return cfg, err
	}
	if cfg.ManifestPoll, err = envDuration(cfg.getenv(EnvManifestPoll), EnvManifestPoll); err != nil {
		return cfg, err
	}
	if cfg.DrainTimeout, err = envDuration(cfg.getenv(EnvDrainTimeout), EnvDrainTimeout); err != nil {
		return cfg, err
	}
	if cfg.StartTimeout, err = envDuration(cfg.getenv(EnvStartTimeout), EnvStartTimeout); err != nil {
		return cfg, err
	}
	cfg.MCP = MCPConfig{Mode: strings.ToLower(cfg.getenv(EnvMCP)), Host: cfg.getenv(EnvMCPHost), Token: cfg.getenv(EnvMCPToken)}
	if cfg.MCP.Port, err = envInt(cfg.getenv(EnvMCPPort), EnvMCPPort); err != nil {
		return cfg, err
	}
	return cfg, nil
}

// BrokerKinds parses a LANDFLOW_TRANSPORTS value into the broker kinds it names: lower-cased, deduplicated, without
// the direct faces (http, grpc) and mcp, which the plugin itself serves.
func BrokerKinds(raw string) []string {
	var out []string
	seen := map[string]bool{}
	for _, part := range strings.Split(raw, ",") {
		kind := strings.ToLower(strings.TrimSpace(part))
		if kind == "" || kind == "http" || kind == "grpc" || kind == "mcp" || seen[kind] {
			continue
		}
		seen[kind] = true
		out = append(out, kind)
	}
	return out
}

func envInt(raw, name string) (int, error) {
	if raw == "" || strings.EqualFold(raw, "off") {
		return 0, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("bridge: %s=%q is not a non-negative integer", name, raw)
	}
	return n, nil
}

func envDuration(raw, name string) (time.Duration, error) {
	if raw == "" {
		return 0, nil
	}
	if n, err := strconv.Atoi(raw); err == nil {
		return time.Duration(n) * time.Millisecond, nil
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d < 0 {
		return 0, fmt.Errorf("bridge: %s=%q is not a duration (30s, 500ms) or milliseconds", name, raw)
	}
	return d, nil
}

// ErrNoTarget is returned by New when no target is configured.
var ErrNoTarget = errors.New("bridge: set " + EnvTarget + " to the plugin's address (grpc://127.0.0.1:7202 or http://127.0.0.1:7102)")
