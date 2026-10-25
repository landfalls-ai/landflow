package landflow

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "github.com/landflow/landflow/sdks/go/landflowpb"
)

// registryClient talks to the host registry over HTTP or gRPC.
type registryClient interface {
	Announce(ctx context.Context, req AnnounceRequest) (AnnounceResponse, error)
	Withdraw(ctx context.Context, req WithdrawRequest) error
	Close() error
	String() string
}

// newRegistryClient picks the transport from the URL scheme.
func newRegistryClient(raw string) (registryClient, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("invalid LANDFLOW_REGISTRY_URL %q (want http(s)://host:port, grpc://host:port or off)", raw)
	}
	switch u.Scheme {
	case "http", "https":
		return &httpRegistry{
			url:    strings.TrimRight(raw, "/") + AnnouncePath,
			client: &http.Client{Timeout: 5 * time.Second},
		}, nil
	case "grpc":
		conn, err := grpc.NewClient(u.Host, grpc.WithTransportCredentials(insecure.NewCredentials()))
		if err != nil {
			return nil, fmt.Errorf("registry %s: %w", raw, err)
		}
		return &grpcRegistry{target: raw, conn: conn, client: pb.NewRegistryServiceClient(conn)}, nil
	default:
		return nil, fmt.Errorf("invalid LANDFLOW_REGISTRY_URL %q: unsupported scheme %q", raw, u.Scheme)
	}
}

type httpRegistry struct {
	url    string
	client *http.Client
}

func (r *httpRegistry) String() string { return r.url }
func (r *httpRegistry) Close() error   { r.client.CloseIdleConnections(); return nil }

func (r *httpRegistry) Announce(ctx context.Context, req AnnounceRequest) (AnnounceResponse, error) {
	var out AnnounceResponse
	body, err := r.do(ctx, http.MethodPost, req)
	if err != nil {
		return out, err
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return out, fmt.Errorf("decode AnnounceResponse: %w", err)
	}
	return out, nil
}

func (r *httpRegistry) Withdraw(ctx context.Context, req WithdrawRequest) error {
	_, err := r.do(ctx, http.MethodDelete, req)
	return err
}

func (r *httpRegistry) do(ctx context.Context, method string, payload any) ([]byte, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, method, r.url, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json; charset=utf-8")
	httpReq.Header.Set("Accept", "application/json")
	resp, err := r.client.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		snippet := strings.TrimSpace(string(body))
		if len(snippet) > 200 {
			snippet = snippet[:200] + "…"
		}
		return nil, fmt.Errorf("%s %s: HTTP %d %s", method, r.url, resp.StatusCode, snippet)
	}
	return body, nil
}

type grpcRegistry struct {
	target string
	conn   *grpc.ClientConn
	client pb.RegistryServiceClient
}

func (r *grpcRegistry) String() string { return r.target }
func (r *grpcRegistry) Close() error   { return r.conn.Close() }

func (r *grpcRegistry) Announce(ctx context.Context, req AnnounceRequest) (AnnounceResponse, error) {
	resp, err := r.client.Announce(ctx, &pb.AnnounceRequest{
		Protocol: req.Protocol, Endpoint: req.Endpoint, PluginId: req.PluginID,
		Version: req.Version, TtlSeconds: int32(req.TTLSeconds),
	})
	if err != nil {
		return AnnounceResponse{}, err
	}
	return AnnounceResponse{
		Accepted:                 resp.GetAccepted(),
		HeartbeatIntervalSeconds: int(resp.GetHeartbeatIntervalSeconds()),
		Message:                  resp.GetMessage(),
	}, nil
}

func (r *grpcRegistry) Withdraw(ctx context.Context, req WithdrawRequest) error {
	_, err := r.client.Withdraw(ctx, &pb.WithdrawRequest{Endpoint: req.Endpoint, PluginId: req.PluginID})
	return err
}

// announcer keeps every endpoint's lease alive and withdraws on shutdown.
type announcer struct {
	client     registryClient
	pluginID   string
	version    string
	ttlSeconds int
	logger     *log.Logger

	mu          sync.Mutex
	announced   map[string]bool // endpoints accepted at least once
	unreachable bool            // registry down; logged once until it recovers
	wg          sync.WaitGroup
}

// markReachable records whether the registry answered and reports whether
// that is a change worth logging (so an outage is logged once, not once per
// endpoint and heartbeat).
func (a *announcer) markReachable(ok bool) (changed bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	changed = a.unreachable == ok
	a.unreachable = !ok
	return changed
}

type leaseState int

const (
	stateUnknown leaseState = iota
	stateActive
	stateUnreachable
	stateRejected
)

func (a *announcer) start(ctx context.Context, endpoints []string) {
	for _, ep := range endpoints {
		a.wg.Add(1)
		go func(endpoint string) {
			defer a.wg.Done()
			a.loop(ctx, endpoint)
		}(ep)
	}
}

// loop announces endpoint, then re-announces every heartbeatIntervalSeconds.
// State changes are logged once; an unreachable host is retried quietly.
func (a *announcer) loop(ctx context.Context, endpoint string) {
	interval := DefaultHeartbeatSeconds * time.Second
	state := stateUnknown
	req := AnnounceRequest{
		Protocol: ProtocolVersion, Endpoint: endpoint, PluginID: a.pluginID,
		Version: a.version, TTLSeconds: a.ttlSeconds,
	}
	for {
		callCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		resp, err := a.client.Announce(callCtx, req)
		cancel()
		if ctx.Err() != nil {
			return
		}
		switch {
		case err != nil:
			if a.markReachable(false) {
				a.logger.Printf("registry %s unreachable (%v); will keep retrying quietly every %s", a.client, err, interval)
			}
			state = stateUnreachable
		case !resp.Accepted:
			a.markReachable(true)
			if state != stateRejected {
				a.logger.Printf("registry %s rejected %s: %s", a.client, endpoint, orDefault(resp.Message, "no reason given"))
			}
			state = stateRejected
		default:
			a.markReachable(true)
			if resp.HeartbeatIntervalSeconds > 0 {
				interval = time.Duration(min(resp.HeartbeatIntervalSeconds, 3600)) * time.Second
			}
			if state != stateActive {
				a.logger.Printf("announced %s to %s (heartbeat %s)", endpoint, a.client, interval)
			}
			state = stateActive
			a.mu.Lock()
			a.announced[endpoint] = true
			a.mu.Unlock()
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

// withdraw removes every endpoint that was accepted at least once. It runs
// after the loops have stopped and is bounded by timeout.
func (a *announcer) withdraw(timeout time.Duration) {
	a.wg.Wait()
	a.mu.Lock()
	endpoints := make([]string, 0, len(a.announced))
	for ep := range a.announced {
		endpoints = append(endpoints, ep)
	}
	a.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	for _, ep := range endpoints {
		if err := a.client.Withdraw(ctx, WithdrawRequest{Endpoint: ep, PluginID: a.pluginID}); err != nil {
			a.logger.Printf("withdraw %s from %s failed: %v", ep, a.client, err)
			continue
		}
		a.logger.Printf("withdrew %s from %s", ep, a.client)
	}
	_ = a.client.Close()
}

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}
