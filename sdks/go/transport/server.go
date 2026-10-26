package transport

// The plugin side of generic messaging: Server consumes a plugin's request
// channel over one broker connection and hands each call to a Dispatcher
// (docs/transports.md "Delivery rules (all brokers)"; the SDK's messaging
// binding, sdks/go/messaging.go, wraps one per broker). Mirrors
// packages/transports/src/server.ts.
//
// Delivery rules, all implemented here and never in drivers:
//   - At most once by default: an Execute is acknowledged before it runs, so a
//     crash mid-call never runs it twice.
//   - At least once (acknowledge after the reply) only when the host asked for
//     it (lfdelivery) and the work is safe to repeat: every method but Execute,
//     an Execute of a node the plugin marks idempotent (per node or per
//     operation), or one with an idempotencyKey.
//   - Deadlines (lfdeadline) are checked before dispatch: an expired request is
//     acknowledged and dropped (the host has already failed it), the
//     dispatcher's context ends at the deadline, and no reply goes out after it.
//   - Concurrency: prefetch = the plugin's maxConcurrency, plus the server's own
//     semaphore (at most once acks before running, so prefetch alone would not bound it).
//   - Version skew: a request whose lfmanifest differs from this plugin's
//     manifest hash is put back once (for a replica with the right version to
//     take) and then answered manifest_mismatch with this plugin's hash.
//   - Cancel events on the plugin's control channel cancel the call's context;
//     a cancel that arrives first drops the call.
//   - Announce every 10 s on the registry channel (with a registry proof when
//     LANDFLOW_REGISTRY_SECRET is set), withdraw and drain in-flight calls on Stop.

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// ProtocolVersion is the logical protocol version announces carry.
	ProtocolVersion = "landflow.plugin/v1"
	// DefaultMaxConcurrency is assumed when neither the manifest nor the options say.
	DefaultMaxConcurrency = 16
	// DefaultHeartbeat is the announce interval.
	DefaultHeartbeat = 10 * time.Second
	// DefaultAnnounceTTLSeconds is the lease an announce asks for.
	DefaultAnnounceTTLSeconds = 30
	// DefaultDrainTimeout bounds Server.Stop's wait for calls in flight.
	DefaultDrainTimeout = 30 * time.Second
	cancelledMemory     = time.Minute
)

// ManifestHashOf is hex(SHA-256(JSON.stringify(manifest)))[0..16], the hash the
// host's registry computes over the manifest as the plugin serves it. Pass the
// manifest struct (serialised like SerializeBody, so key order and escaping
// match what a JavaScript host re-serialises) or its JSON bytes.
func ManifestHashOf(manifest any) (string, error) {
	body, err := SerializeBody(manifest)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])[:16], nil
}

// AnnounceBody is the body of an announce (a heartbeat is an announce repeated
// every 10 s) on the registry channel (docs/protocol.md §14.8).
type AnnounceBody struct {
	Protocol     string `json:"protocol"`
	PluginID     string `json:"pluginId"`
	Version      string `json:"version"`
	InstanceID   string `json:"instanceId"`
	ManifestHash string `json:"manifestHash"`
	// Endpoint is <kind>://<connectionId>/<pluginId>.
	Endpoint       string `json:"endpoint"`
	MaxConcurrency int    `json:"maxConcurrency"`
	TTLSeconds     int    `json:"ttlSeconds"`
	// RegistryProof is the protocol §13 proof with the event id as the challenge; absent when the plugin has no LANDFLOW_REGISTRY_SECRET.
	RegistryProof string `json:"registryProof,omitempty"`
	// Transports lists the faces this plugin process started (the manifest's
	// transports hint), so a host learns them from the announce. Additive; a
	// host that does not know it ignores it.
	Transports []string `json:"transports,omitempty"`
}

// WithdrawBody is the body of a withdraw on the registry channel.
type WithdrawBody struct {
	PluginID   string `json:"pluginId"`
	InstanceID string `json:"instanceId"`
	Endpoint   string `json:"endpoint"`
}

// DispatchContext is what the Dispatcher learns about a call besides its body.
// The ctx the dispatcher receives ends at Deadline and when the host cancels.
type DispatchContext struct {
	CallID string
	Method Method
	// Deadline is zero when the request carries none.
	Deadline       time.Time
	IdempotencyKey string
	// Attempt is the broker's delivery attempt (1 on the first).
	Attempt     int
	Delivery    DeliveryMode
	TraceParent string
	TraceState  string
	// Source is the host that called, landflow://host/<instanceId>.
	Source string
}

// Dispatcher runs one logical RPC: the SDK's dispatcher behind every face. body
// is the method's request JSON; the result is marshalled as the response body
// (a struct, map, or json.RawMessage). Return a *DispatchError for a coded
// failure; any other error answers internal, and a ctx error after cancellation
// answers cancelled (or expired at the deadline).
type Dispatcher func(ctx context.Context, method Method, body json.RawMessage, dc DispatchContext) (any, error)

// DispatchError is a failure with a code the host can act on (not_found for an
// unknown node, bad_request for an invalid body, capacity when refused at the
// concurrency limit…).
type DispatchError struct {
	Code    RemoteErrorCode
	Message string
	Details map[string]any
}

func (e *DispatchError) Error() string { return e.Message }

// NewDispatchError builds a DispatchError (code "" = internal).
func NewDispatchError(code RemoteErrorCode, message string) *DispatchError {
	if code == "" {
		code = CodeInternal
	}
	return &DispatchError{Code: code, Message: message}
}

// ServerOptions configures a Server.
type ServerOptions struct {
	// Driver is a fresh, unconnected driver; the server connects it in Start and closes it in Stop.
	Driver   Driver
	Keyring  *Keyring
	PluginID string
	Version  string
	// ManifestHash is the plugin's manifest hash (ManifestHashOf). When empty,
	// Manifest is hashed.
	ManifestHash string
	// Manifest is the manifest (the SDK's PluginManifest struct or JSON bytes);
	// used for ManifestHash and, by default, for IsIdempotent.
	Manifest any
	Dispatch Dispatcher
	// IsIdempotent says whether an Execute body is safe to run twice. Default:
	// from the manifest's idempotent flags when Manifest was given, else never.
	IsIdempotent func(body json.RawMessage) bool
	// MaxConcurrency is the prefetch and the semaphore (default: the manifest's maxConcurrency, else 16).
	MaxConcurrency int
	// InstanceID is random per process by default; share the SDK's InstanceID() so announces over every transport agree.
	InstanceID string
	// Transports are the faces this process started, listed in announces (optional).
	Transports       []string
	AnnounceInterval time.Duration
	TTLSeconds       int
	// RegistrySecret proves announces (default LANDFLOW_REGISTRY_SECRET); NoRegistryProof announces without one.
	RegistrySecret  string
	NoRegistryProof bool
	// DrainTimeout bounds how long Stop waits for calls in flight (default 30 s).
	DrainTimeout time.Duration
	ClockSkew    time.Duration
	Log          Logger
	Now          func() time.Time
}

// Counters are the server's counts, for tests and metrics.
type Counters struct {
	Received, Dispatched, Replied, Dropped, Expired, Mismatched, Requeued, Cancelled, Announces int64
}

type counters struct {
	received, dispatched, replied, dropped, expired, mismatched, requeued, cancelled, announces atomic.Int64
}

func (c *counters) snapshot() Counters {
	return Counters{
		Received: c.received.Load(), Dispatched: c.dispatched.Load(), Replied: c.replied.Load(), Dropped: c.dropped.Load(),
		Expired: c.expired.Load(), Mismatched: c.mismatched.Load(), Requeued: c.requeued.Load(), Cancelled: c.cancelled.Load(), Announces: c.announces.Load(),
	}
}

type inFlight struct {
	cancel context.CancelCauseFunc
	done   chan struct{}
}

type serverState int

const (
	stateNew serverState = iota
	stateStarted
	stateDraining
	stateStopped
)

// Server is the plugin side: one per broker connection.
type Server struct {
	opts         ServerOptions
	InstanceID   string
	PluginID     string
	ManifestHash string
	Names        Names
	// Endpoint is <kind>://<connectionId>/<pluginId>.
	Endpoint string

	codec          *Codec
	log            Logger
	now            func() time.Time
	isIdempotent   func(json.RawMessage) bool
	maxConcurrency int
	registrySecret string
	slots          chan struct{}
	counters       counters

	mu            sync.Mutex
	state         serverState
	inFlight      map[string]*inFlight
	cancelled     map[string]time.Time
	subscriptions []Subscription
	stopAnnounce  chan struct{}
	announceDone  chan struct{}
}

// NewServer builds a server; Start connects it.
func NewServer(opts ServerOptions) (*Server, error) {
	if opts.Driver == nil || opts.Keyring == nil || opts.Dispatch == nil || opts.PluginID == "" {
		return nil, &UsageError{Message: "transport.NewServer needs Driver, Keyring, Dispatch and PluginID"}
	}
	if err := CheckName("plugin id", opts.PluginID); err != nil {
		return nil, &UsageError{Message: err.Error()}
	}
	hash := opts.ManifestHash
	if hash == "" {
		if opts.Manifest == nil {
			return nil, &UsageError{Message: "transport.NewServer needs ManifestHash or Manifest"}
		}
		var err error
		if hash, err = ManifestHashOf(opts.Manifest); err != nil {
			return nil, err
		}
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	logger := opts.Log
	if logger == nil {
		logger = StdLogger(nil)
	}
	instanceID := opts.InstanceID
	if instanceID == "" {
		instanceID = randomHex(16)
	}
	isIdempotent := opts.IsIdempotent
	if isIdempotent == nil {
		if opts.Manifest != nil {
			isIdempotent = IdempotencyFromManifest(opts.Manifest)
		} else {
			isIdempotent = func(json.RawMessage) bool { return false }
		}
	}
	maxConcurrency := opts.MaxConcurrency
	if maxConcurrency <= 0 && opts.Manifest != nil {
		maxConcurrency = manifestMaxConcurrency(opts.Manifest)
	}
	if maxConcurrency <= 0 {
		maxConcurrency = DefaultMaxConcurrency
	}
	secret := ""
	if !opts.NoRegistryProof {
		secret = opts.RegistrySecret
		if secret == "" {
			secret = os.Getenv(RegistrySecretEnv)
		}
	}
	cfg := opts.Driver.Config()
	s := &Server{
		opts: opts, InstanceID: instanceID, PluginID: opts.PluginID, ManifestHash: hash, Names: NewNames(cfg.Prefix),
		Endpoint: BrokerEndpoint(opts.Driver.Kind(), cfg.ConnectionID, opts.PluginID),
		log:      logger, now: now, isIdempotent: isIdempotent, maxConcurrency: maxConcurrency, registrySecret: secret,
		slots:    make(chan struct{}, maxConcurrency),
		inFlight: map[string]*inFlight{}, cancelled: map[string]time.Time{},
	}
	s.codec = NewCodec(opts.Keyring, opts.Driver.Capabilities(), CodecOptions{ClockSkew: opts.ClockSkew, Replay: NewReplayGuard(0, 0), Now: now})
	return s, nil
}

// StartServer is NewServer followed by Start.
func StartServer(ctx context.Context, opts ServerOptions) (*Server, error) {
	s, err := NewServer(opts)
	if err != nil {
		return nil, err
	}
	if err := s.Start(ctx); err != nil {
		return nil, err
	}
	return s, nil
}

// Driver is the server's driver.
func (s *Server) Driver() Driver { return s.opts.Driver }

// MaxConcurrency is the prefetch and semaphore size.
func (s *Server) MaxConcurrency() int { return s.maxConcurrency }

// Counters is a snapshot of the counts.
func (s *Server) Counters() Counters { return s.counters.snapshot() }

// InFlightCount is the number of calls running.
func (s *Server) InFlightCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.inFlight)
}

// Start connects, declares the channels, consumes them and announces. ctx bounds the setup.
func (s *Server) Start(ctx context.Context) error {
	s.mu.Lock()
	if s.state != stateNew {
		s.mu.Unlock()
		return &UsageError{Message: "server already started"}
	}
	s.mu.Unlock()
	driver := s.opts.Driver
	if err := driver.Connect(ctx); err != nil {
		return fmt.Errorf("transport: connect %s %q: %w", driver.Kind(), driver.Config().ConnectionID, err)
	}
	request := s.Names.Request(s.PluginID)
	instance := s.Names.Instance(s.PluginID, s.InstanceID)
	control := s.Names.Control(s.PluginID)
	registry := s.Names.Registry()
	if err := driver.Declare(ctx, []ChannelSpec{RequestSpec(request, 0), InstanceSpec(instance), ControlSpec(control), RegistrySpec(registry)}); err != nil {
		_ = driver.Close()
		return fmt.Errorf("transport: declare channels: %w", err)
	}
	var subs []Subscription
	subscribe := func(channel string, opts ConsumeOptions, handler Handler) error {
		sub, err := driver.Consume(ctx, channel, opts, handler)
		if err != nil {
			return fmt.Errorf("transport: consume %s: %w", channel, err)
		}
		subs = append(subs, sub)
		return nil
	}
	if err := subscribe(control, ConsumeOptions{Prefetch: 256, AckMode: AckAuto}, func(_ context.Context, wire WireEvent, _ Delivery) { s.onControl(wire) }); err == nil {
		err = subscribe(request, ConsumeOptions{Group: request, Prefetch: s.maxConcurrency, AckMode: AckManual}, s.onRequest)
		if err == nil {
			err = subscribe(instance, ConsumeOptions{Group: instance, Prefetch: s.maxConcurrency, AckMode: AckManual}, s.onRequest)
		}
		if err != nil {
			s.closeSubscriptions(subs)
			_ = driver.Close()
			return err
		}
	} else {
		_ = driver.Close()
		return err
	}
	s.mu.Lock()
	s.subscriptions = subs
	s.state = stateStarted
	s.stopAnnounce = make(chan struct{})
	s.announceDone = make(chan struct{})
	s.mu.Unlock()
	s.Announce(ctx)
	interval := s.opts.AnnounceInterval
	if interval <= 0 {
		interval = DefaultHeartbeat
	}
	go s.announceLoop(interval)
	return nil
}

func (s *Server) announceLoop(interval time.Duration) {
	defer close(s.announceDone)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-s.stopAnnounce:
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(context.Background(), interval)
			s.Announce(ctx)
			cancel()
		}
	}
}

func (s *Server) closeSubscriptions(subs []Subscription) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, sub := range subs {
		_ = sub.Close(ctx)
	}
}

// Stop stops taking calls, withdraws, waits for the calls in flight (up to
// DrainTimeout, or ctx), closes the subscriptions and the driver.
func (s *Server) Stop(ctx context.Context) error {
	s.mu.Lock()
	if s.state == stateStopped || s.state == stateDraining || s.state == stateNew {
		if s.state == stateNew {
			s.state = stateStopped
			s.mu.Unlock()
			return s.opts.Driver.Close()
		}
		s.mu.Unlock()
		return nil
	}
	s.state = stateDraining
	close(s.stopAnnounce)
	subs := s.subscriptions
	s.subscriptions = nil
	s.mu.Unlock()
	<-s.announceDone
	s.withdraw(ctx)

	drain := s.opts.DrainTimeout
	if drain <= 0 {
		drain = DefaultDrainTimeout
	}
	drainCtx, cancel := context.WithTimeout(ctx, drain)
	defer cancel()
	s.mu.Lock()
	pending := make([]*inFlight, 0, len(s.inFlight))
	for _, f := range s.inFlight {
		pending = append(pending, f)
	}
	s.mu.Unlock()
	for _, f := range pending {
		select {
		case <-f.done:
		case <-drainCtx.Done():
		}
	}
	s.mu.Lock()
	for _, f := range s.inFlight {
		f.cancel(errors.New("plugin stopping"))
	}
	s.mu.Unlock()
	s.closeSubscriptions(subs)
	s.mu.Lock()
	s.state = stateStopped
	s.mu.Unlock()
	return s.opts.Driver.Close()
}

func (s *Server) started() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state == stateStarted
}

// Announce publishes an announce now (the heartbeat does it every AnnounceInterval).
func (s *Server) Announce(ctx context.Context) {
	if !s.started() {
		return
	}
	attributes := s.codec.Base(PluginSource(s.PluginID, s.InstanceID), AnnounceType)
	attributes.LfManifest = s.ManifestHash
	ttl := s.opts.TTLSeconds
	if ttl <= 0 {
		ttl = DefaultAnnounceTTLSeconds
	}
	body := AnnounceBody{
		Protocol: ProtocolVersion, PluginID: s.PluginID, Version: s.opts.Version, InstanceID: s.InstanceID, ManifestHash: s.ManifestHash,
		Endpoint: s.Endpoint, MaxConcurrency: s.maxConcurrency, TTLSeconds: ttl, Transports: s.opts.Transports,
	}
	if s.registrySecret != "" {
		body.RegistryProof = RegistryProof(s.registrySecret, s.PluginID, attributes.ID)
	}
	packed, err := s.codec.Pack(s.PluginID, attributes, body, false)
	if err == nil {
		_, err = s.opts.Driver.Publish(ctx, s.Names.Registry(), packed.Wire, PublishOptions{TTL: time.Minute})
	}
	if err != nil {
		s.log("warn", "announce failed", "error", err.Error())
		return
	}
	s.counters.announces.Add(1)
}

func (s *Server) withdraw(ctx context.Context) {
	attributes := s.codec.Base(PluginSource(s.PluginID, s.InstanceID), WithdrawType)
	body := WithdrawBody{PluginID: s.PluginID, InstanceID: s.InstanceID, Endpoint: s.Endpoint}
	packed, err := s.codec.Pack(s.PluginID, attributes, body, false)
	if err == nil {
		_, err = s.opts.Driver.Publish(ctx, s.Names.Registry(), packed.Wire, PublishOptions{TTL: time.Minute})
	}
	if err != nil {
		s.log("warn", "withdraw failed", "error", err.Error())
	}
}

func (s *Server) onRequest(_ context.Context, wire WireEvent, delivery Delivery) {
	s.counters.received.Add(1)
	ctx := context.Background()
	drop := func(why string, fields ...any) {
		s.counters.dropped.Add(1)
		s.log("warn", "dropped a request: "+why, fields...)
		_ = delivery.Nack(ctx, false)
	}
	raw, err := s.codec.Peek(wire)
	if err != nil {
		drop("malformed", "error", err.Error())
		return
	}
	parsed, ok := ParseType(raw.Attributes.Type)
	if !ok || parsed.Kind != KindRequest {
		drop("not a request", "type", raw.Attributes.Type)
		return
	}
	opened, err := s.codec.Unpack(raw, s.PluginID)
	if err != nil {
		drop("failed verification", "id", raw.Attributes.ID, "error", err.Error())
		return
	}
	attributes, data := opened.Attributes, json.RawMessage(opened.Body)
	requeue := func() {
		s.codec.ForgetReplay(attributes.ID)
		s.counters.requeued.Add(1)
		_ = delivery.Nack(ctx, true)
	}
	if !s.started() {
		// Draining: hand it back to another replica without running it.
		requeue()
		return
	}
	now := s.now()
	deadline := attributes.Deadline()
	if !deadline.IsZero() && !deadline.After(now) {
		s.counters.expired.Add(1)
		s.log("debug", "dropped an expired request", "id", attributes.ID)
		_ = delivery.Ack(ctx)
		return
	}
	if s.takeCancelled(attributes.ID, now) {
		s.counters.cancelled.Add(1)
		_ = delivery.Ack(ctx)
		return
	}
	if attributes.LfManifest != "" && attributes.LfManifest != s.ManifestHash {
		s.counters.mismatched.Add(1)
		if delivery.Attempt() < 2 && s.opts.Driver.Capabilities().Nack {
			requeue()
			return
		}
		_ = delivery.Ack(ctx)
		s.reply(ctx, attributes, delivery, map[string]any{"error": "manifest mismatch: this plugin runs " + s.ManifestHash, "manifestHash": s.ManifestHash}, CodeManifestMismatch)
		return
	}
	requested := attributes.LfDelivery
	if requested == "" {
		requested = AtLeastOnce
		if parsed.Method == MethodExecute {
			requested = AtMostOnce
		}
	}
	repeatable := parsed.Method != MethodExecute || attributes.LfIdempotency != "" || s.safeToRepeat(data)
	mode := AtMostOnce
	if requested == AtLeastOnce && repeatable {
		mode = AtLeastOnce
	}
	s.slots <- struct{}{}
	defer func() { <-s.slots }()
	if !s.started() {
		requeue()
		return
	}
	// Re-check after waiting for the slot: a cancel may have arrived or the deadline passed meanwhile.
	now = s.now()
	if !deadline.IsZero() && !deadline.After(now) {
		s.counters.expired.Add(1)
		s.log("debug", "dropped a request that expired while waiting for a slot", "id", attributes.ID)
		_ = delivery.Ack(ctx)
		return
	}
	if s.takeCancelled(attributes.ID, now) {
		s.counters.cancelled.Add(1)
		_ = delivery.Ack(ctx)
		return
	}
	if mode == AtMostOnce {
		_ = delivery.Ack(ctx)
	}

	callCtx, cancel := context.WithCancelCause(ctx)
	if !deadline.IsZero() {
		var cancelDeadline context.CancelFunc
		callCtx, cancelDeadline = context.WithDeadline(callCtx, deadline)
		defer cancelDeadline()
	}
	flight := &inFlight{cancel: cancel, done: make(chan struct{})}
	s.mu.Lock()
	s.inFlight[attributes.ID] = flight
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.inFlight, attributes.ID)
		s.mu.Unlock()
		cancel(nil)
		close(flight.done)
	}()

	s.counters.dispatched.Add(1)
	dc := DispatchContext{
		CallID: attributes.ID, Method: parsed.Method, Deadline: deadline, IdempotencyKey: attributes.LfIdempotency, Attempt: delivery.Attempt(),
		Delivery: mode, TraceParent: attributes.TraceParent, TraceState: attributes.TraceState, Source: attributes.Source,
	}
	result, code := s.dispatch(callCtx, parsed.Method, data, dc)
	sent := s.reply(ctx, attributes, delivery, result, code)
	if mode == AtLeastOnce {
		if sent {
			_ = delivery.Ack(ctx)
		} else {
			requeue()
		}
	}
}

func (s *Server) dispatch(ctx context.Context, method Method, body json.RawMessage, dc DispatchContext) (result any, code RemoteErrorCode) {
	defer func() {
		if r := recover(); r != nil {
			s.log("error", "dispatcher panicked", "id", dc.CallID, "panic", fmt.Sprint(r))
			result, code = map[string]any{"error": fmt.Sprintf("dispatcher panicked: %v", r)}, CodeInternal
		}
	}()
	out, err := s.opts.Dispatch(ctx, method, body, dc)
	if err == nil {
		return out, ""
	}
	var de *DispatchError
	switch {
	case ctx.Err() != nil:
		msg := err.Error()
		if cause := context.Cause(ctx); cause != nil && !errors.Is(cause, context.Canceled) && !errors.Is(cause, context.DeadlineExceeded) {
			msg = cause.Error()
		}
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return map[string]any{"error": msg}, CodeExpired
		}
		return map[string]any{"error": msg}, CodeCancelled
	case errors.As(err, &de):
		body := map[string]any{"error": de.Message}
		for k, v := range de.Details {
			body[k] = v
		}
		if de.Code == "" {
			return body, CodeInternal
		}
		return body, de.Code
	default:
		return map[string]any{"error": err.Error()}, CodeInternal
	}
}

func (s *Server) safeToRepeat(data json.RawMessage) (ok bool) {
	defer func() {
		if recover() != nil {
			ok = false
		}
	}()
	return s.isIdempotent(data)
}

// reply sends a response; false when it could not be sent (the host gets its deadline).
func (s *Server) reply(ctx context.Context, request Attributes, delivery Delivery, body any, code RemoteErrorCode) bool {
	parsed, ok := ParseType(request.Type)
	if !ok || parsed.Kind != KindRequest {
		return false
	}
	if deadline := request.Deadline(); !deadline.IsZero() && !deadline.After(s.now()) {
		// The host has already failed the call at its deadline; a late reply would only race its timer.
		s.counters.expired.Add(1)
		s.log("debug", "not replying after the deadline", "id", request.ID)
		return true
	}
	native := s.opts.Driver.Capabilities().Replies == RepliesNative
	if !native && request.LfReplyTo == "" {
		s.log("warn", "request has no lfreplyto and the broker has no native replies", "id", request.ID)
		return false
	}
	attributes := s.codec.Base(PluginSource(s.PluginID, s.InstanceID), ResponseType(parsed.Method))
	attributes.LfCorrelation = request.ID
	attributes.LfManifest = s.ManifestHash
	attributes.Subject = request.Subject
	attributes.TraceParent = request.TraceParent
	attributes.TraceState = request.TraceState
	attributes.LfError = code
	packed, err := s.codec.Pack(s.PluginID, attributes, body, true)
	if err != nil {
		var ee *EnvelopeError
		if !errors.As(err, &ee) || ee.Reason != ReasonTooLarge {
			s.log("error", "reply could not be encoded", "id", request.ID, "error", err.Error())
			attributes.LfError = CodeInternal
			packed, err = s.codec.Pack(s.PluginID, attributes, map[string]any{"error": "response could not be encoded: " + err.Error()}, true)
		} else {
			attributes.LfError = CodeTooLarge
			packed, err = s.codec.Pack(s.PluginID, attributes, map[string]any{"error": ee.Message}, true)
		}
		if err != nil {
			return false
		}
	}
	if native {
		replier, ok := delivery.(Replier)
		if !ok {
			s.log("error", "driver claims native replies but the delivery has no Reply", "id", request.ID)
			return false
		}
		err = replier.Reply(ctx, packed.Wire)
	} else {
		_, err = s.opts.Driver.Publish(ctx, request.LfReplyTo, packed.Wire, PublishOptions{TTL: 5 * time.Minute})
	}
	if err != nil {
		s.log("warn", "reply could not be published", "id", request.ID, "error", err.Error())
		return false
	}
	s.counters.replied.Add(1)
	return true
}

func (s *Server) onControl(wire WireEvent) {
	raw, err := s.codec.Peek(wire)
	if err != nil {
		return
	}
	parsed, ok := ParseType(raw.Attributes.Type)
	if !ok || parsed.Kind != KindCancel || raw.Attributes.LfCorrelation == "" {
		return
	}
	if _, err := s.codec.UnpackWith(raw, s.PluginID, nil); err != nil {
		s.log("warn", "ignored a cancel that failed verification", "error", err.Error())
		return
	}
	callID := raw.Attributes.LfCorrelation
	s.mu.Lock()
	defer s.mu.Unlock()
	if flight, ok := s.inFlight[callID]; ok {
		s.counters.cancelled.Add(1)
		flight.cancel(errors.New("cancelled by the host"))
		return
	}
	now := s.now()
	s.sweepCancelledLocked(now)
	s.cancelled[callID] = now.Add(cancelledMemory)
}

// takeCancelled reports (and forgets) a cancel that arrived before its request.
func (s *Server) takeCancelled(callID string, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepCancelledLocked(now)
	if _, ok := s.cancelled[callID]; ok {
		delete(s.cancelled, callID)
		return true
	}
	return false
}

func (s *Server) sweepCancelledLocked(now time.Time) {
	for id, expires := range s.cancelled {
		if !expires.After(now) {
			delete(s.cancelled, id)
		}
	}
}

// manifestShape is the part of a manifest the server reads.
type manifestShape struct {
	Plugin struct {
		ID string `json:"id"`
	} `json:"plugin"`
	Nodes []struct {
		Name       string `json:"name"`
		Idempotent *bool  `json:"idempotent"`
		Properties []struct {
			Name    string `json:"name"`
			Options []struct {
				Value      any   `json:"value"`
				Idempotent *bool `json:"idempotent"`
			} `json:"options"`
		} `json:"properties"`
	} `json:"nodes"`
	MaxConcurrency int `json:"maxConcurrency"`
}

func decodeManifest(manifest any) (manifestShape, error) {
	body, err := SerializeBody(manifest)
	if err != nil {
		return manifestShape{}, err
	}
	var shape manifestShape
	if err := json.Unmarshal(body, &shape); err != nil {
		return manifestShape{}, err
	}
	return shape, nil
}

func manifestMaxConcurrency(manifest any) int {
	shape, err := decodeManifest(manifest)
	if err != nil {
		return 0
	}
	return shape.MaxConcurrency
}

// IdempotencyFromManifest says which Execute bodies a manifest marks idempotent:
// the node's idempotent flag, overridden by the idempotent flag of the selected
// operation option. manifest is the SDK's PluginManifest struct or JSON bytes.
func IdempotencyFromManifest(manifest any) func(body json.RawMessage) bool {
	shape, err := decodeManifest(manifest)
	if err != nil {
		return func(json.RawMessage) bool { return false }
	}
	type nodeInfo struct {
		idempotent bool
		operations map[string]bool
	}
	nodes := map[string]nodeInfo{}
	for _, node := range shape.Nodes {
		info := nodeInfo{idempotent: node.Idempotent != nil && *node.Idempotent, operations: map[string]bool{}}
		for _, prop := range node.Properties {
			if prop.Name != "operation" {
				continue
			}
			for _, option := range prop.Options {
				if option.Idempotent != nil {
					info.operations[fmt.Sprint(option.Value)] = *option.Idempotent
				}
			}
		}
		nodes[shape.Plugin.ID+"."+node.Name] = info
	}
	return func(body json.RawMessage) bool {
		var req struct {
			Node struct {
				Type string `json:"type"`
			} `json:"node"`
			Parameters map[string]any `json:"parameters"`
		}
		if json.Unmarshal(body, &req) != nil {
			return false
		}
		info, ok := nodes[req.Node.Type]
		if !ok {
			return false
		}
		if op, ok := req.Parameters["operation"]; ok {
			if v, ok := info.operations[fmt.Sprint(op)]; ok {
				return v
			}
		}
		return info.idempotent
	}
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic("transport: crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}
