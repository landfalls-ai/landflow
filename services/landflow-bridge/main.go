// Command landflow-bridge sits next to any plugin that speaks landflow.plugin/v1 over HTTP or gRPC and serves it
// over every broker the Go messaging core has a driver for (docs/transports.md "How each language gets every
// broker"). Configuration is by environment, with the Go SDK's names; every flag mirrors a variable and wins over it.
//
//	LANDFLOW_BRIDGE_TARGET=grpc://127.0.0.1:7202 LANDFLOW_TRANSPORTS=nats LANDFLOW_NATS_URL=nats://127.0.0.1:54222 \
//	LANDFLOW_TRANSPORT_SECRET=… landflow-bridge
//
// See README.md for every variable.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/landflow/landflow/sdks/go/transport"

	"github.com/landflow/landflow/services/landflow-bridge/bridge"
)

// version is set with -ldflags "-X main.version=…".
var version = "dev"

func main() {
	os.Exit(run(os.Args[1:], os.Getenv))
}

func run(args []string, getenv func(string) string) int {
	cfg, err := bridge.ConfigFromEnv(getenv)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	fs := flag.NewFlagSet("landflow-bridge", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	target := fs.String("target", cfg.Target, "the plugin: grpc://host:port or http://host:port ("+bridge.EnvTarget+")")
	transports := fs.String("transports", strings.Join(cfg.Kinds, ","), "comma-separated broker kinds to serve; empty = every kind with a LANDFLOW_<KIND>_URL ("+bridge.EnvTransports+")")
	instanceID := fs.String("instance-id", cfg.InstanceID, "the plugin's instance id, so its endpoints merge on the host ("+bridge.EnvInstanceID+")")
	healthPort := fs.Int("health-port", cfg.HealthPort, "serve GET /healthz on this port; 0 = off ("+bridge.EnvHealthPort+")")
	healthHost := fs.String("health-host", cfg.HealthHost, "health listen host ("+bridge.EnvHealthHost+", default 127.0.0.1)")
	manifestPoll := fs.Duration("manifest-poll", cfg.ManifestPoll, "how often to re-read the plugin's manifest; 0 = 30s ("+bridge.EnvManifestPoll+")")
	drain := fs.Duration("drain-timeout", cfg.DrainTimeout, "how long to wait for calls in flight on stop; 0 = 30s ("+bridge.EnvDrainTimeout+")")
	maxConcurrency := fs.Int("max-concurrency", cfg.MaxConcurrency, "override the manifest's maxConcurrency ("+bridge.EnvMaxConc+")")
	mcp := fs.String("mcp", cfg.MCP.Mode, "MCP face: on | off ("+bridge.EnvMCP+", default off)")
	mcpPort := fs.Int("mcp-port", cfg.MCP.Port, "MCP face port ("+bridge.EnvMCPPort+")")
	mcpHost := fs.String("mcp-host", cfg.MCP.Host, "MCP face host ("+bridge.EnvMCPHost+", default 127.0.0.1)")
	mcpToken := fs.String("mcp-token", cfg.MCP.Token, "MCP bearer token ("+bridge.EnvMCPToken+"); required off loopback")
	logLevel := fs.String("log-level", getenv(bridge.EnvLogLevel), "debug | info | warn | error ("+bridge.EnvLogLevel+")")
	logFormat := fs.String("log-format", getenv(bridge.EnvLogFormat), "json | pretty ("+bridge.EnvLogFormat+")")
	showVersion := fs.Bool("version", false, "print the version and the built-in drivers, then exit")
	if err := fs.Parse(args); err != nil {
		if err == flag.ErrHelp {
			return 0
		}
		return 2
	}
	if *showVersion {
		fmt.Printf("landflow-bridge %s (drivers: %s)\n", version, strings.Join(transport.DriverKinds(), ", "))
		return 0
	}
	cfg.Target, cfg.Kinds, cfg.InstanceID = *target, bridge.BrokerKinds(*transports), *instanceID
	cfg.HealthPort, cfg.HealthHost, cfg.ManifestPoll, cfg.DrainTimeout, cfg.MaxConcurrency = *healthPort, *healthHost, *manifestPoll, *drain, *maxConcurrency
	cfg.MCP = bridge.MCPConfig{Mode: *mcp, Port: *mcpPort, Host: *mcpHost, Token: *mcpToken}
	cfg.Logger = bridge.NewLogger(os.Stdout, *logLevel, *logFormat)
	logger := cfg.Logger.With("version", version)

	b, err := bridge.New(cfg)
	if err != nil {
		logger.Error(err.Error())
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	logger.Info("starting", "target", cfg.Target, "kinds", strings.Join(b.Kinds(), ","), "drivers", strings.Join(transport.DriverKinds(), ","))
	err = b.Run(ctx)
	stop() // a second signal now kills the process the default way
	if err != nil && ctx.Err() == nil {
		logger.Error(err.Error())
		return 1
	}
	if err != nil {
		logger.Warn("stopped with an error", "error", err.Error())
	}
	return 0
}
