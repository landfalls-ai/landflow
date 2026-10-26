package bridge

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/landflow/landflow/sdks/go/transport"
)

// HealthReport is what GET /healthz returns (and Bridge.Health).
type HealthReport struct {
	// Status is ok, degraded (the plugin did not answer the last manifest check) or stopped.
	Status       string         `json:"status"`
	PluginID     string         `json:"pluginId"`
	Version      string         `json:"version"`
	ManifestHash string         `json:"manifestHash"`
	InstanceID   string         `json:"instanceId"`
	UptimeMs     int64          `json:"uptimeMs"`
	Target       TargetHealth   `json:"target"`
	Brokers      []BrokerHealth `json:"brokers"`
}

// TargetHealth is the plugin behind the bridge as of the last manifest check.
type TargetHealth struct {
	URL       string    `json:"url"`
	Reachable bool      `json:"reachable"`
	Error     string    `json:"error,omitempty"`
	CheckedAt time.Time `json:"checkedAt"`
}

// BrokerHealth is one messaging server.
type BrokerHealth struct {
	Kind         string             `json:"kind"`
	ConnectionID string             `json:"connectionId"`
	Endpoint     string             `json:"endpoint"`
	Prefetch     int                `json:"prefetch"`
	InFlight     int                `json:"inFlight"`
	Counters     transport.Counters `json:"counters"`
}

// Health reports the bridge's state.
func (b *Bridge) Health() HealthReport {
	b.mu.Lock()
	state, manifest, ts, servers, startedAt := b.state, b.manifest, b.target_, b.servers, b.startedAt
	b.mu.Unlock()
	report := HealthReport{Status: "ok", InstanceID: b.instanceID, Brokers: []BrokerHealth{}, Target: TargetHealth{URL: b.target.URL(), Reachable: ts.reachable, Error: ts.err, CheckedAt: ts.checkedAt}}
	if manifest != nil {
		report.PluginID, report.Version, report.ManifestHash = manifest.info.PluginID, manifest.info.Version, manifest.hash
	}
	if !startedAt.IsZero() {
		report.UptimeMs = time.Since(startedAt).Milliseconds()
	}
	switch {
	case state == stateStopped:
		report.Status = "stopped"
	case state == stateNew:
		report.Status = "starting"
	case !ts.reachable:
		report.Status = "degraded"
	}
	for _, s := range servers {
		report.Brokers = append(report.Brokers, BrokerHealth{
			Kind: s.Driver().Kind(), ConnectionID: s.Driver().Config().ConnectionID, Endpoint: s.Endpoint,
			Prefetch: s.MaxConcurrency(), InFlight: s.InFlightCount(), Counters: s.Counters(),
		})
	}
	return report
}

type healthServer struct {
	addr   string
	server *http.Server
}

func startHealthServer(host string, port int, b *Bridge) (*healthServer, error) {
	ln, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return nil, err
	}
	mux := http.NewServeMux()
	handler := func(w http.ResponseWriter, r *http.Request) {
		report := b.Health()
		status := http.StatusOK
		if report.Status != "ok" {
			status = http.StatusServiceUnavailable
		}
		data, _ := json.Marshal(report)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(status)
		_, _ = w.Write(append(data, '\n'))
	}
	mux.HandleFunc("GET /healthz", handler)
	mux.HandleFunc("GET /{$}", handler)
	hs := &healthServer{addr: ln.Addr().String(), server: &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}}
	go func() { _ = hs.server.Serve(ln) }()
	return hs, nil
}

func (h *healthServer) close(ctx context.Context) error { return h.server.Shutdown(ctx) }
