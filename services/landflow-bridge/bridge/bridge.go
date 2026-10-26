package bridge

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/landflow/landflow/sdks/go/transport"
)

// Bridge serves one target plugin over the configured brokers.
type Bridge struct {
	cfg        Config
	log        *slog.Logger
	target     Target
	keyring    *transport.Keyring
	factories  []DriverFactory
	kinds      []string
	instanceID string
	startedAt  time.Time
	claims     transport.ClaimStore
	claimTTL   time.Duration

	mu       sync.Mutex
	state    bridgeState
	manifest *manifestState
	servers  []*transport.Server
	target_  targetStatus
	seenMism int64

	stop       chan struct{}
	refreshNow chan struct{}
	loops      sync.WaitGroup
	health     *healthServer
	mcp        *mcpServer
	stopMCP    func(context.Context)
}

type bridgeState int

const (
	stateNew bridgeState = iota
	stateStarted
	stateStopped
)

// manifestState is the manifest the bridge serves, with what it read out of it.
type manifestState struct {
	raw  json.RawMessage
	hash string
	info ManifestInfo
}

type targetStatus struct {
	reachable bool
	err       string
	checkedAt time.Time
}

// New validates cfg, builds the target and the driver factories. Nothing connects until Start.
func New(cfg Config) (*Bridge, error) {
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	target, err := NewTarget(cfg.Target)
	if err != nil {
		return nil, err
	}
	keyring := cfg.Keyring
	if keyring == nil {
		if keyring, err = transport.KeyringFromEnv(cfg.getenv); err != nil {
			_ = target.Close()
			return nil, fmt.Errorf("bridge: %w", err)
		}
	}
	factories := cfg.Drivers
	if len(factories) == 0 {
		if factories, err = DriverFactoriesFromEnv(cfg.Kinds, cfg.getenv, cfg.environ); err != nil {
			_ = target.Close()
			return nil, err
		}
	}
	if len(factories) == 0 {
		_ = target.Close()
		return nil, fmt.Errorf("bridge: no broker to serve: set %s=kafka,nats,… and LANDFLOW_<KIND>_URL for each (registered drivers: %v)", EnvTransports, transport.DriverKinds())
	}
	var kinds []string
	seen := map[string]bool{}
	for _, f := range factories {
		if f.Kind == "" || f.New == nil {
			_ = target.Close()
			return nil, errors.New("bridge: every DriverFactory needs a Kind and New")
		}
		if !seen[f.Kind] {
			seen[f.Kind] = true
			kinds = append(kinds, f.Kind)
		}
	}
	sort.Strings(kinds)
	claims, claimTTL := cfg.Claims, cfg.ClaimTTL
	if claims == nil && !cfg.NoClaims {
		if value := cfg.getenv(transport.ClaimStoreEnv); value != "" {
			setting, err := transport.ParseClaimStore(value, cfg.getenv)
			if err != nil {
				_ = target.Close()
				return nil, fmt.Errorf("bridge: %w", err)
			}
			claims, claimTTL = setting.Store, setting.TTL
			logger.Info("claim check on", "store", setting.Describe)
		}
	}
	instanceID := cfg.InstanceID
	if instanceID == "" {
		instanceID = randomHex(16)
	}
	if err := transport.CheckName("instance id", instanceID); err != nil {
		_ = target.Close()
		return nil, fmt.Errorf("bridge: %s: %w", EnvInstanceID, err)
	}
	if cfg.ManifestPoll <= 0 {
		cfg.ManifestPoll = DefaultManifestPoll
	}
	if cfg.DrainTimeout <= 0 {
		cfg.DrainTimeout = DefaultDrainTimeout
	}
	if cfg.StartTimeout <= 0 {
		cfg.StartTimeout = DefaultStartTimeout
	}
	if cfg.HealthHost == "" {
		cfg.HealthHost = DefaultHealthHost
	}
	return &Bridge{cfg: cfg, log: logger, target: target, keyring: keyring, factories: factories, kinds: kinds, instanceID: instanceID, claims: claims, claimTTL: claimTTL}, nil
}

// Kinds are the broker kinds this bridge serves, sorted.
func (b *Bridge) Kinds() []string { return append([]string(nil), b.kinds...) }

// InstanceID is the instance id announced on every broker.
func (b *Bridge) InstanceID() string { return b.instanceID }

// ManifestHash is the hash the bridge currently announces ("" before Start).
func (b *Bridge) ManifestHash() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.manifest == nil {
		return ""
	}
	return b.manifest.hash
}

// Manifest is the manifest as served over the brokers (nil before Start).
func (b *Bridge) Manifest() json.RawMessage {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.manifest == nil {
		return nil
	}
	return append(json.RawMessage(nil), b.manifest.raw...)
}

// PluginID is the target plugin's id ("" before Start).
func (b *Bridge) PluginID() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.manifest == nil {
		return ""
	}
	return b.manifest.info.PluginID
}

// Servers are the running messaging servers, one per broker connection.
func (b *Bridge) Servers() []*transport.Server {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]*transport.Server(nil), b.servers...)
}

// Endpoints are the brokered endpoints (<kind>://<connectionId>/<pluginId>) the bridge announces.
func (b *Bridge) Endpoints() []string {
	var out []string
	for _, s := range b.Servers() {
		out = append(out, s.Endpoint)
	}
	return out
}

// Start fetches the manifest (retrying until StartTimeout: the plugin may still be starting), starts one server per
// broker, the health endpoint, the MCP face (when built in) and the manifest watcher.
func (b *Bridge) Start(ctx context.Context) error {
	b.mu.Lock()
	if b.state != stateNew {
		b.mu.Unlock()
		return errors.New("bridge: already started")
	}
	b.mu.Unlock()
	state, err := b.fetchManifestUntil(ctx, b.cfg.StartTimeout)
	if err != nil {
		return err
	}
	servers, err := b.startServers(ctx, state)
	if err != nil {
		return err
	}
	b.mu.Lock()
	b.manifest = state
	b.servers = servers
	b.state = stateStarted
	b.startedAt = time.Now()
	b.stop = make(chan struct{})
	b.refreshNow = make(chan struct{}, 1)
	b.mu.Unlock()
	for _, s := range servers {
		b.log.Info("serving over the broker", "plugin", state.info.PluginID, "version", state.info.Version, "endpoint", s.Endpoint,
			"kind", s.Driver().Kind(), "manifest_hash", state.hash, "instance", b.instanceID, "prefetch", s.MaxConcurrency(), "target", b.target.URL())
	}
	if b.cfg.HealthPort > 0 {
		hs, err := startHealthServer(b.cfg.HealthHost, b.cfg.HealthPort, b)
		if err != nil {
			_ = b.Stop(ctx)
			return err
		}
		b.health = hs
		b.log.Info("health endpoint", "url", fmt.Sprintf("http://%s/healthz", hs.addr))
	}
	b.stopMCP = b.startMCP(ctx)
	b.loops.Add(1)
	go b.watchManifest()
	return nil
}

// Run is Start, wait for ctx, Stop.
func (b *Bridge) Run(ctx context.Context) error {
	if err := b.Start(ctx); err != nil {
		return err
	}
	<-ctx.Done()
	b.log.Info("shutting down", "cause", context.Cause(ctx))
	stopCtx, cancel := context.WithTimeout(context.Background(), b.cfg.DrainTimeout+5*time.Second)
	defer cancel()
	return b.Stop(stopCtx)
}

// Stop withdraws from every broker, drains calls in flight (DrainTimeout), closes the drivers, the health endpoint
// and the target connection.
func (b *Bridge) Stop(ctx context.Context) error {
	b.mu.Lock()
	if b.state == stateStopped {
		b.mu.Unlock()
		return nil
	}
	wasStarted := b.state == stateStarted
	b.state = stateStopped
	servers := b.servers
	b.servers = nil
	if b.stop != nil {
		close(b.stop)
	}
	b.mu.Unlock()
	if wasStarted {
		b.loops.Wait()
	}
	if b.stopMCP != nil {
		b.stopMCP(ctx)
	}
	err := b.stopServers(ctx, servers)
	if b.health != nil {
		_ = b.health.close(ctx)
	}
	if cerr := b.target.Close(); err == nil {
		err = cerr
	}
	b.log.Info("stopped")
	return err
}

// RefreshManifest re-reads the manifest now (the watcher does it every ManifestPoll and after a manifest_mismatch).
func (b *Bridge) RefreshManifest() {
	b.mu.Lock()
	ch := b.refreshNow
	b.mu.Unlock()
	if ch == nil {
		return
	}
	select {
	case ch <- struct{}{}:
	default:
	}
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

func (b *Bridge) fetchManifestUntil(ctx context.Context, timeout time.Duration) (*manifestState, error) {
	deadline := time.Now().Add(timeout)
	wait := 250 * time.Millisecond
	for attempt := 1; ; attempt++ {
		state, err := b.fetchManifest(ctx)
		if err == nil {
			return state, nil
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if time.Now().Add(wait).After(deadline) {
			return nil, fmt.Errorf("bridge: the plugin at %s did not answer GetManifest within %s: %w", b.target.URL(), timeout, err)
		}
		if attempt == 1 || attempt%10 == 0 {
			b.log.Warn("waiting for the plugin's manifest", "target", b.target.URL(), "error", err.Error(), "attempt", attempt)
		}
		select {
		case <-time.After(wait):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		if wait < 2*time.Second {
			wait *= 2
		}
	}
}

// fetchManifest reads the manifest, adds the bridged kinds to its transports hint and hashes it.
func (b *Bridge) fetchManifest(ctx context.Context) (*manifestState, error) {
	fetchCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	raw, err := b.target.Manifest(fetchCtx)
	b.mu.Lock()
	b.target_ = targetStatus{reachable: err == nil, checkedAt: time.Now()}
	if err != nil {
		b.target_.err = err.Error()
	}
	b.mu.Unlock()
	if err != nil {
		return nil, err
	}
	info, err := decodeManifestInfo(raw)
	if err != nil {
		return nil, err
	}
	served, err := withTransports(raw, b.kinds)
	if err != nil {
		return nil, fmt.Errorf("bridge: manifest: %w", err)
	}
	info, _ = decodeManifestInfo(served)
	hash, err := transport.ManifestHashOf(served)
	if err != nil {
		return nil, err
	}
	return &manifestState{raw: served, hash: hash, info: info}, nil
}

func (b *Bridge) watchManifest() {
	defer b.loops.Done()
	poll := time.NewTicker(b.cfg.ManifestPoll)
	defer poll.Stop()
	// The mismatch watcher: a host that knows a newer hash makes the servers answer manifest_mismatch; re-read at once.
	mismatch := time.NewTicker(time.Second)
	defer mismatch.Stop()
	var lastForced time.Time
	for {
		select {
		case <-b.stop:
			return
		case <-poll.C:
			b.refresh()
		case <-b.refreshNow:
			b.refresh()
		case <-mismatch.C:
			var total int64
			for _, s := range b.Servers() {
				total += s.Counters().Mismatched
			}
			b.mu.Lock()
			grew := total > b.seenMism
			b.seenMism = total
			b.mu.Unlock()
			if grew && time.Since(lastForced) > 5*time.Second {
				lastForced = time.Now()
				b.log.Info("a request carried another manifest hash; re-reading the manifest")
				b.refresh()
			}
		}
	}
}

// refresh re-reads the manifest and, when its hash changed, starts servers on the new hash and stops the old ones.
func (b *Bridge) refresh() {
	ctx := context.Background()
	state, err := b.fetchManifest(ctx)
	if err != nil {
		b.log.Warn("manifest check failed", "target", b.target.URL(), "error", err.Error())
		return
	}
	b.mu.Lock()
	current := b.manifest
	running := b.state == stateStarted
	b.mu.Unlock()
	if !running || (current != nil && current.hash == state.hash) {
		return
	}
	b.log.Info("manifest changed; restarting the broker servers", "plugin", state.info.PluginID, "version", state.info.Version, "from", current.hash, "to", state.hash)
	servers, err := b.startServers(ctx, state)
	if err != nil {
		b.log.Error("could not start servers on the new manifest; keeping the old ones", "error", err.Error())
		return
	}
	b.mu.Lock()
	if b.state != stateStarted {
		b.mu.Unlock()
		_ = b.stopServers(ctx, servers)
		return
	}
	old := b.servers
	b.servers = servers
	b.manifest = state
	b.mu.Unlock()
	if err := b.stopServers(ctx, old); err != nil {
		b.log.Warn("stopping the previous servers", "error", err.Error())
	}
	// The old servers withdrew this instance id; announce it again on the new hash at once.
	for _, s := range servers {
		s.Announce(ctx)
	}
	b.refreshMCP()
}

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

func (b *Bridge) startServers(ctx context.Context, state *manifestState) ([]*transport.Server, error) {
	var servers []*transport.Server
	for _, f := range b.factories {
		server, err := b.startServer(ctx, f, state)
		if err != nil {
			_ = b.stopServers(ctx, servers)
			return nil, err
		}
		servers = append(servers, server)
	}
	return servers, nil
}

// startServerAttempts is how many times a broker connection is tried: brokers that were just (re)started, and
// topics whose metadata is still propagating (Kafka), answer the second attempt.
const startServerAttempts = 3

func (b *Bridge) startServer(ctx context.Context, f DriverFactory, state *manifestState) (*transport.Server, error) {
	var last error
	for attempt := 1; attempt <= startServerAttempts; attempt++ {
		driver, err := f.New()
		if err != nil {
			return nil, fmt.Errorf("bridge: %s driver: %w", f.Kind, err)
		}
		server, err := transport.NewServer(transport.ServerOptions{
			Driver: driver, Keyring: b.keyring, PluginID: state.info.PluginID, Version: state.info.Version,
			ManifestHash: state.hash, Manifest: state.raw, Dispatch: b.dispatch, MaxConcurrency: b.cfg.MaxConcurrency,
			InstanceID: b.instanceID, Transports: state.info.Transports, AnnounceInterval: b.cfg.AnnounceInterval,
			RegistrySecret: b.cfg.RegistrySecret, NoRegistryProof: b.cfg.NoRegistryProof, DrainTimeout: b.cfg.DrainTimeout, Claims: b.claims, ClaimTTL: b.claimTTL,
			Log: b.transportLogger(f.Kind),
		})
		if err != nil {
			return nil, fmt.Errorf("bridge: %s: %w", f.Kind, err)
		}
		if err := server.Start(ctx); err == nil {
			return server, nil
		} else {
			last = err
		}
		if attempt < startServerAttempts {
			b.log.Warn("broker server did not start; retrying", "kind", f.Kind, "attempt", attempt, "error", last.Error())
			select {
			case <-time.After(time.Duration(attempt) * 500 * time.Millisecond):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
	}
	return nil, fmt.Errorf("bridge: %s: %w", f.Kind, last)
}

func (b *Bridge) stopServers(ctx context.Context, servers []*transport.Server) error {
	var (
		wg   sync.WaitGroup
		mu   sync.Mutex
		errs []error
	)
	for _, s := range servers {
		wg.Add(1)
		go func(s *transport.Server) {
			defer wg.Done()
			if err := s.Stop(ctx); err != nil {
				mu.Lock()
				errs = append(errs, fmt.Errorf("%s: %w", s.Driver().Kind(), err))
				mu.Unlock()
			}
		}(s)
	}
	wg.Wait()
	return errors.Join(errs...)
}

// dispatch is the transport.Dispatcher behind every server: GetManifest answers from the manifest the bridge
// announces (so the hash the host learns always matches what it is served); everything else goes to the plugin.
func (b *Bridge) dispatch(ctx context.Context, method transport.Method, body json.RawMessage, dc transport.DispatchContext) (any, error) {
	if b.cfg.Observe != nil {
		b.cfg.Observe(method, dc)
	}
	if method == transport.MethodGetManifest {
		if m := b.Manifest(); m != nil {
			return m, nil
		}
	}
	for attempt := 1; ; attempt++ {
		out, err := b.target.Call(ctx, method, body, dc.Deadline)
		if err == nil {
			return out, nil
		}
		var de *transport.DispatchError
		if !errors.As(err, &de) {
			return nil, err
		}
		if de.Code != transport.CodeCapacity {
			if de.Code != transport.CodeExpired && de.Code != transport.CodeCancelled {
				b.log.Debug("forwarded call failed", "method", string(method), "call", dc.CallID, "code", string(de.Code), "error", de.Message)
			}
			return nil, err
		}
		// The plugin refused at its concurrency limit (429 / RESOURCE_EXHAUSTED): the call never ran. A brokered call
		// is never bounced back as capacity (the broker is the buffer the host spilled over to): hold it and retry after
		// Retry-After (1 s default) until its deadline, which then fails it expired like any slow call.
		if err := b.holdForCapacity(ctx, dc, de, attempt); err != nil {
			return nil, err
		}
	}
}

// capacityHoldWithoutDeadline bounds the hold of a request that carries no deadline (requests always do, §14.5).
const capacityHoldWithoutDeadline = 30 * time.Second

func (b *Bridge) holdForCapacity(ctx context.Context, dc transport.DispatchContext, de *transport.DispatchError, attempt int) error {
	wait := time.Second
	if d, ok := de.Details[retryAfterKey].(time.Duration); ok && d > 0 {
		wait = d
	}
	if dc.Deadline.IsZero() && time.Duration(attempt)*wait > capacityHoldWithoutDeadline {
		return de
	}
	if attempt == 1 {
		b.log.Debug("plugin at capacity; holding the brokered call", "method", string(dc.Method), "call", dc.CallID, "retry_after", wait.String())
	}
	select {
	case <-ctx.Done():
		return ctxErr(ctx)
	case <-time.After(wait):
		return nil
	}
}

func (b *Bridge) transportLogger(kind string) transport.Logger {
	l := b.log.With("kind", kind)
	return func(level, message string, fields ...any) {
		switch level {
		case "debug":
			l.Debug(message, fields...)
		case "warn":
			l.Warn(message, fields...)
		case "error":
			l.Error(message, fields...)
		default:
			l.Info(message, fields...)
		}
	}
}

func randomHex(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		panic("bridge: crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(buf)
}
