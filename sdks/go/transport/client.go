package transport

// The host side of generic messaging: Client calls plugins over one broker
// connection (docs/transports.md "Generic messaging"; landflow-bridge and the
// tests use it). Mirrors packages/transports/src/client.ts.
//
//   - Call publishes a signed, encrypted request on the plugin's request channel
//     and correlates the reply, over the broker's native request/reply or over
//     this host's reply channel; the deadline fails the call with *TimeoutError
//     and a cancelled ctx sends a cancel event to the plugin's control channel.
//   - Errors say what is known: *UndeliverableError (provably not delivered; the
//     selector may use another transport), *TimeoutError / *CancelledError /
//     *ConnectionLostError (maybe delivered), *RemoteError (the plugin answered).
//   - Discovery: it consumes the registry channel and keeps the announced
//     plugins (Plugins, OnPlugin), with their brokered endpoint; instances
//     expire without heartbeats.
//   - Stats: driver stats on every known plugin's request channel every 5 s.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"sync"
	"time"
)

const (
	DefaultCallTimeout   = 30 * time.Second
	DefaultStatsInterval = 5 * time.Second
	expirySweep          = time.Second
)

// ClientOptions configures a Client.
type ClientOptions struct {
	// Driver is a fresh, unconnected driver; the client connects it in Start and closes it in Close.
	Driver  Driver
	Keyring *Keyring
	// HostInstanceID names this host process (the reply channel is named after it). Default: random.
	HostInstanceID string
	// StatsInterval samples driver stats; negative disables (0 = 5 s).
	StatsInterval time.Duration
	ClockSkew     time.Duration
	// RegistrySecret is the secret announces must prove (default LANDFLOW_REGISTRY_SECRET); NoRegistryProof accepts
	// announces without a proof (their signature still has to verify).
	RegistrySecret  string
	NoRegistryProof bool
	// NoDiscovery skips the registry channel.
	NoDiscovery bool
	// Claims is the claim store (LANDFLOW_CLAIM_STORE): a request or reply that does not fit the broker goes by reference
	// through it. Without one such a call fails with ReasonTooLargeEvent. ClaimTTL (default 1 h) bounds how long an orphaned
	// object lives; the sweeper runs every ClaimSweepInterval (default 10 min).
	Claims             ClaimStore
	ClaimTTL           time.Duration
	ClaimSweepInterval time.Duration
	Log                Logger
	Now                func() time.Time
}

// CallOptions tunes one Call.
type CallOptions struct {
	// Deadline after which the call must not run; default now + Timeout.
	Deadline time.Time
	// Timeout is the alternative to Deadline (default 30 s).
	Timeout        time.Duration
	IdempotencyKey string
	// Delivery: default at-most-once for Execute, at-least-once for every other method.
	Delivery DeliveryMode
	// OrderingKey keeps the plugin's deliveries for one key in order (the execution id), when the broker can.
	OrderingKey string
	// ManifestHash the host knows for the plugin; default: the announced one.
	ManifestHash string
	// InstanceID sends to one instance's channel instead of the shared request channel.
	InstanceID  string
	TraceParent string
	TraceState  string
	// Attempt is the host's attempt number for this call (1 on the first try).
	Attempt int
}

// Reply is a successful response.
type Reply struct {
	Body       json.RawMessage
	Attributes Attributes
	// InstanceID is the plugin instance that answered.
	InstanceID string
	Elapsed    time.Duration
}

// AnnouncedInstance is one live plugin process.
type AnnouncedInstance struct {
	InstanceID     string
	Version        string
	ManifestHash   string
	MaxConcurrency int
	Transports     []string
	LastSeen       time.Time
	// ExpiresAt is when this instance is forgotten without a new heartbeat.
	ExpiresAt time.Time
}

// AnnouncedPlugin is a plugin seen on the registry channel.
type AnnouncedPlugin struct {
	PluginID string
	// Version and ManifestHash are from the most recent heartbeat.
	Version      string
	ManifestHash string
	// Endpoint is <kind>://<connectionId>/<pluginId>.
	Endpoint  string
	Instances []AnnouncedInstance
	LastSeen  time.Time
}

// PluginEventType is what happened to a plugin instance.
type PluginEventType string

const (
	PluginAnnounced PluginEventType = "announced"
	PluginUpdated   PluginEventType = "updated"
	PluginWithdrawn PluginEventType = "withdrawn"
	PluginExpired   PluginEventType = "expired"
)

// PluginEvent is a discovery event.
type PluginEvent struct {
	Type       PluginEventType
	Plugin     AnnouncedPlugin
	InstanceID string
}

// SampledStats is a driver stats sample with its time.
type SampledStats struct {
	ChannelStats
	SampledAt time.Time
}

type pendingCall struct {
	pluginID string
	method   Method
	result   chan pendingResult
}

type pendingResult struct {
	attributes Attributes
	data       json.RawMessage
	err        error
}

type knownPlugin struct {
	plugin    AnnouncedPlugin
	instances map[string]AnnouncedInstance
}

type clientState int

const (
	clientNew clientState = iota
	clientStarted
	clientClosed
)

// Client is the host side: one per broker connection.
type Client struct {
	opts           ClientOptions
	HostInstanceID string
	Names          Names
	codec          *Codec
	log            Logger
	now            func() time.Time
	registrySecret string

	mu            sync.Mutex
	state         clientState
	pending       map[string]*pendingCall
	known         map[string]*knownPlugin
	sampled       map[string]SampledStats
	listeners     map[int]func(PluginEvent)
	nextListener  int
	declared      map[string]bool
	subscriptions []Subscription
	stop          chan struct{}
	loops         sync.WaitGroup
}

// NewClient builds a client; Start connects it.
func NewClient(opts ClientOptions) (*Client, error) {
	if opts.Driver == nil || opts.Keyring == nil {
		return nil, &UsageError{Message: "transport.NewClient needs Driver and Keyring"}
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	logger := opts.Log
	if logger == nil {
		logger = StdLogger(nil)
	}
	id := opts.HostInstanceID
	if id == "" {
		id = randomHex(8)
	}
	secret := ""
	if !opts.NoRegistryProof {
		secret = opts.RegistrySecret
		if secret == "" {
			secret = os.Getenv(RegistrySecretEnv)
		}
	}
	c := &Client{
		opts: opts, HostInstanceID: id, Names: NewNames(opts.Driver.Config().Prefix), log: logger, now: now, registrySecret: secret,
		pending: map[string]*pendingCall{}, known: map[string]*knownPlugin{}, sampled: map[string]SampledStats{}, listeners: map[int]func(PluginEvent){}, declared: map[string]bool{},
	}
	c.codec = NewCodec(opts.Keyring, opts.Driver.Capabilities(), CodecOptions{ClockSkew: opts.ClockSkew, Now: now, Claims: opts.Claims})
	return c, nil
}

// StartClient is NewClient followed by Start.
func StartClient(ctx context.Context, opts ClientOptions) (*Client, error) {
	c, err := NewClient(opts)
	if err != nil {
		return nil, err
	}
	if err := c.Start(ctx); err != nil {
		return nil, err
	}
	return c, nil
}

// Driver is the client's driver.
func (c *Client) Driver() Driver { return c.opts.Driver }

// Kind is the driver's kind.
func (c *Client) Kind() string { return c.opts.Driver.Kind() }

// ConnectionID is the broker connection's id.
func (c *Client) ConnectionID() string { return c.opts.Driver.Config().ConnectionID }

// EndpointOf is the brokered endpoint of a plugin on this connection.
func (c *Client) EndpointOf(pluginID string) string {
	return BrokerEndpoint(c.Kind(), c.ConnectionID(), pluginID)
}

// Start connects and subscribes to the reply and registry channels.
func (c *Client) Start(ctx context.Context) error {
	c.mu.Lock()
	if c.state != clientNew {
		c.mu.Unlock()
		return &UsageError{Message: "client already started"}
	}
	c.mu.Unlock()
	driver := c.opts.Driver
	if err := driver.Connect(ctx); err != nil {
		return &UndeliverableError{Reason: ReasonNotConnected, Message: fmt.Sprintf("cannot connect to %s %q: %v", driver.Kind(), c.ConnectionID(), err)}
	}
	native := driver.Capabilities().Replies == RepliesNative
	var specs []ChannelSpec
	if !native {
		specs = append(specs, ReplySpec(c.Names.Reply(c.HostInstanceID)))
	}
	if !c.opts.NoDiscovery {
		specs = append(specs, RegistrySpec(c.Names.Registry()))
	}
	if len(specs) > 0 {
		if err := driver.Declare(ctx, specs); err != nil {
			_ = driver.Close()
			return fmt.Errorf("transport: declare channels: %w", err)
		}
	}
	var subs []Subscription
	for _, spec := range specs {
		c.declared[spec.Name] = true
	}
	if !native {
		sub, err := driver.Consume(ctx, c.Names.Reply(c.HostInstanceID), ConsumeOptions{Prefetch: 1024, AckMode: AckAuto}, func(_ context.Context, wire WireEvent, _ Delivery) { c.onReply(wire, "") })
		if err != nil {
			_ = driver.Close()
			return fmt.Errorf("transport: consume reply channel: %w", err)
		}
		subs = append(subs, sub)
	}
	if !c.opts.NoDiscovery {
		sub, err := driver.Consume(ctx, c.Names.Registry(), ConsumeOptions{Prefetch: 1024, AckMode: AckAuto}, func(_ context.Context, wire WireEvent, _ Delivery) { c.onRegistry(wire) })
		if err != nil {
			c.closeSubscriptions(subs)
			_ = driver.Close()
			return fmt.Errorf("transport: consume registry channel: %w", err)
		}
		subs = append(subs, sub)
	}
	c.mu.Lock()
	c.subscriptions = subs
	c.state = clientStarted
	c.stop = make(chan struct{})
	c.mu.Unlock()
	if !c.opts.NoDiscovery {
		c.loops.Add(1)
		go c.loop(expirySweep, func() { c.expireInstances() })
	}
	if c.opts.Claims != nil {
		startClaimSweeper(c.opts.Claims, c.opts.ClaimTTL, c.opts.ClaimSweepInterval, c.stop, c.log, c.now)
	}
	statsInterval := c.opts.StatsInterval
	if statsInterval == 0 {
		statsInterval = DefaultStatsInterval
	}
	if _, ok := driver.(StatsReporter); ok && statsInterval > 0 {
		c.loops.Add(1)
		go c.loop(statsInterval, func() {
			ctx, cancel := context.WithTimeout(context.Background(), statsInterval)
			defer cancel()
			c.SampleStats(ctx)
		})
	}
	return nil
}

func (c *Client) loop(interval time.Duration, fn func()) {
	defer c.loops.Done()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-c.stop:
			return
		case <-ticker.C:
			fn()
		}
	}
}

func (c *Client) closeSubscriptions(subs []Subscription) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, sub := range subs {
		_ = sub.Close(ctx)
	}
}

// Call calls method on pluginID and returns the reply body. body is any
// JSON-marshalable value or json.RawMessage. Cancelling ctx after publishing
// sends a cancel and fails with *CancelledError.
func (c *Client) Call(ctx context.Context, pluginID string, method Method, body any, opts CallOptions) (json.RawMessage, error) {
	reply, err := c.Invoke(ctx, pluginID, method, body, opts)
	if err != nil {
		return nil, err
	}
	return reply.Body, nil
}

// CallInto is Call that decodes the reply body into out.
func (c *Client) CallInto(ctx context.Context, pluginID string, method Method, body any, opts CallOptions, out any) error {
	raw, err := c.Call(ctx, pluginID, method, body, opts)
	if err != nil {
		return err
	}
	if out == nil || len(raw) == 0 {
		return nil
	}
	return json.Unmarshal(raw, out)
}

// Invoke is Call with the reply's attributes, the answering instance and the elapsed time.
func (c *Client) Invoke(ctx context.Context, pluginID string, method Method, body any, opts CallOptions) (Reply, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	c.mu.Lock()
	state := c.state
	c.mu.Unlock()
	if state != clientStarted {
		return Reply{}, &UndeliverableError{Reason: ReasonNotConnected, Message: "client is not started"}
	}
	if err := CheckName("plugin id", pluginID); err != nil {
		return Reply{}, &UsageError{Message: err.Error()}
	}
	if _, ok := methodSegments[method]; !ok {
		return Reply{}, &UsageError{Message: fmt.Sprintf("unknown method %q", method)}
	}
	if ctx.Err() != nil {
		return Reply{}, &UndeliverableError{Reason: ReasonAborted, Message: "aborted before publishing"}
	}
	startedAt := c.now()
	deadline := opts.Deadline
	if deadline.IsZero() {
		timeout := opts.Timeout
		if timeout <= 0 {
			timeout = DefaultCallTimeout
		}
		deadline = startedAt.Add(timeout)
		if ctxDeadline, ok := ctx.Deadline(); ok && ctxDeadline.Before(deadline) {
			deadline = ctxDeadline
		}
	}
	if !deadline.After(startedAt) {
		return Reply{}, &TimeoutError{Deadline: deadline, Message: "the deadline had already passed"}
	}
	remaining := deadline.Sub(startedAt)
	c.mu.Lock()
	known := c.known[pluginID]
	manifestHash := opts.ManifestHash
	if manifestHash == "" && known != nil {
		manifestHash = known.plugin.ManifestHash
	}
	noInstances := known != nil && len(known.instances) == 0
	stats, hasStats := c.sampled[pluginID]
	c.mu.Unlock()

	channel := c.Names.Request(pluginID)
	if opts.InstanceID != "" {
		channel = c.Names.Instance(pluginID, opts.InstanceID)
	}
	caps := c.opts.Driver.Capabilities()
	native := caps.Replies == RepliesNative
	attributes := c.codec.Base(HostSource(c.HostInstanceID), RequestType(method))
	attributes.LfDeadline = fmt.Sprint(deadline.UnixMilli())
	attempt := opts.Attempt
	if attempt <= 0 {
		attempt = 1
	}
	attributes.LfAttempt = fmt.Sprint(attempt)
	attributes.LfDelivery = opts.Delivery
	if attributes.LfDelivery == "" {
		attributes.LfDelivery = AtLeastOnce
		if method == MethodExecute {
			attributes.LfDelivery = AtMostOnce
		}
	}
	if !native {
		attributes.LfReplyTo = c.Names.Reply(c.HostInstanceID)
	}
	attributes.LfManifest = manifestHash
	attributes.LfIdempotency = opts.IdempotencyKey
	attributes.TraceParent = opts.TraceParent
	attributes.TraceState = opts.TraceState
	bodyBytes, err := SerializeBody(body)
	if err != nil {
		return Reply{}, &UsageError{Message: err.Error()}
	}
	attributes.Subject = SubjectOf(method, bodyBytes)
	packed, err := c.codec.PackBodyClaimed(ctx, pluginID, attributes, bodyBytes, true)
	if err != nil {
		var ee *EnvelopeError
		var ce *ClaimError
		if errors.As(err, &ee) && ee.Reason == ReasonTooLarge {
			return Reply{}, &UndeliverableError{Reason: ReasonTooLargeEvent, Message: ee.Message}
		}
		if errors.As(err, &ce) {
			return Reply{}, &UndeliverableError{Reason: ReasonClaimFailed, Message: ce.Message}
		}
		return Reply{}, err
	}
	// A call that did not get its reply never reached the receiver's ack: nobody else will delete the request body.
	succeeded := false
	if packed.ClaimKey != "" {
		defer func() {
			if !succeeded {
				c.dropClaim(packed.ClaimKey)
			}
		}()
	}
	// Provably undeliverable before publishing: every announced instance has stopped heartbeating, or the channel has no consumers.
	if noInstances {
		return Reply{}, &UndeliverableError{Reason: ReasonNoConsumers, Message: fmt.Sprintf("no instance of %q has announced itself in the last %d s", pluginID, DefaultAnnounceTTLSeconds)}
	}
	if caps.Undeliverable == UndeliverableInferred && hasStats && stats.Consumers != nil && *stats.Consumers == 0 && stats.SampledAt.After(startedAt.Add(-2*DefaultStatsInterval)) {
		return Reply{}, &UndeliverableError{Reason: ReasonNoConsumers, Message: fmt.Sprintf("%q has no consumers on %s", pluginID, channel)}
	}
	spec := RequestSpec(channel, 0)
	if opts.InstanceID != "" {
		spec = InstanceSpec(channel) // not durable: no stream per instance on JetStream-like brokers
	}
	if err := c.declareOnce(ctx, spec); err != nil {
		return Reply{}, &ConnectionLostError{Message: fmt.Sprintf("declaring %s failed: %v", channel, err)}
	}
	callID := packed.Attributes.ID
	pending := &pendingCall{pluginID: pluginID, method: method, result: make(chan pendingResult, 1)}
	c.mu.Lock()
	c.pending[callID] = pending
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.pending, callID)
		c.mu.Unlock()
	}()

	publishErr := make(chan error, 1)
	publishCtx, cancelPublish := context.WithCancel(context.Background())
	defer cancelPublish()
	go func() {
		if native {
			requester, ok := c.opts.Driver.(Requester)
			if !ok {
				publishErr <- &UsageError{Message: "driver claims native replies but does not implement Requester"}
				return
			}
			res, err := requester.Request(publishCtx, channel, packed.Wire, RequestOptions{Timeout: remaining, OrderingKey: opts.OrderingKey})
			if err != nil {
				publishErr <- err
				return
			}
			switch res.Outcome {
			case RequestUnroutable:
				publishErr <- &UndeliverableError{Reason: ReasonUnroutable, Message: "nobody is consuming " + channel}
			case RequestTimeout:
				publishErr <- &TimeoutError{Deadline: deadline, Message: fmt.Sprintf("no reply from %q within %d ms; the call may have run", pluginID, remaining.Milliseconds())}
			default:
				c.onReply(res.Event, callID)
			}
			return
		}
		outcome, err := c.opts.Driver.Publish(publishCtx, channel, packed.Wire, PublishOptions{OrderingKey: opts.OrderingKey, TTL: remaining})
		if err != nil {
			publishErr <- err
			return
		}
		if outcome == Unroutable {
			publishErr <- &UndeliverableError{Reason: ReasonUnroutable, Message: "nobody is consuming " + channel}
		}
	}()

	timer := time.NewTimer(remaining)
	defer timer.Stop()
	var res pendingResult
	select {
	case res = <-pending.result:
	case err := <-publishErr:
		var ue *UndeliverableError
		var te *TimeoutError
		switch {
		case errors.As(err, &ue), errors.As(err, &te):
			return Reply{}, err
		case IsNotConnected(err):
			return Reply{}, &UndeliverableError{Reason: ReasonNotConnected, Message: fmt.Sprintf("not connected to %s %q: %v", c.Kind(), c.ConnectionID(), err)}
		default:
			var usage *UsageError
			if errors.As(err, &usage) {
				return Reply{}, err
			}
			return Reply{}, &ConnectionLostError{Message: fmt.Sprintf("publishing to %s failed: %v; the call may have run", channel, err)}
		}
	case <-timer.C:
		return Reply{}, &TimeoutError{Deadline: deadline, Message: fmt.Sprintf("no reply from %q within %d ms; the call may have run", pluginID, remaining.Milliseconds())}
	case <-ctx.Done():
		go c.sendCancel(pluginID, callID, context.Cause(ctx))
		return Reply{}, &CancelledError{}
	}
	if res.err != nil {
		return Reply{}, res.err
	}
	succeeded = true
	_, instanceID, _ := ParsePluginSource(res.attributes.Source)
	if res.attributes.LfError != "" {
		var details map[string]any
		_ = json.Unmarshal(res.data, &details)
		message := fmt.Sprintf("plugin answered %s", res.attributes.LfError)
		if m, ok := details["error"].(string); ok {
			message = m
		}
		if res.attributes.LfError == CodeClaimUnavailable {
			return Reply{}, &ClaimUnavailableError{Message: message}
		}
		if res.attributes.LfError == CodeManifestMismatch {
			actual := res.attributes.LfManifest
			if actual == "" {
				actual, _ = details["manifestHash"].(string)
			}
			return Reply{}, &ManifestMismatchError{Expected: manifestHash, Actual: actual}
		}
		return Reply{}, &RemoteError{RemoteCode: res.attributes.LfError, Message: message, Details: details}
	}
	return Reply{Body: res.data, Attributes: res.attributes, InstanceID: instanceID, Elapsed: c.now().Sub(startedAt)}, nil
}

// Plugins are the plugins seen on the registry channel with at least one live
// instance, plus those whose instances all expired (empty Instances). Sorted by id.
func (c *Client) Plugins() []AnnouncedPlugin {
	c.expireInstances()
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]AnnouncedPlugin, 0, len(c.known))
	for _, k := range c.known {
		out = append(out, k.plugin)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].PluginID < out[j].PluginID })
	return out
}

// Plugin is one announced plugin; ok is false when never seen.
func (c *Client) Plugin(pluginID string) (AnnouncedPlugin, bool) {
	c.expireInstances()
	c.mu.Lock()
	defer c.mu.Unlock()
	k, ok := c.known[pluginID]
	if !ok {
		return AnnouncedPlugin{}, false
	}
	return k.plugin, true
}

// Stats is the last driver stats sample for the plugin's request channel.
func (c *Client) Stats(pluginID string) (SampledStats, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	s, ok := c.sampled[pluginID]
	return s, ok
}

// SampleStats samples now (the timer does it every StatsInterval).
func (c *Client) SampleStats(ctx context.Context) {
	reporter, ok := c.opts.Driver.(StatsReporter)
	if !ok {
		return
	}
	c.mu.Lock()
	if c.state != clientStarted {
		c.mu.Unlock()
		return
	}
	ids := make([]string, 0, len(c.known))
	for id := range c.known {
		ids = append(ids, id)
	}
	c.mu.Unlock()
	for _, id := range ids {
		stats, err := reporter.Stats(ctx, c.Names.Request(id))
		if err != nil {
			c.log("debug", "stats failed", "plugin", id, "error", err.Error())
			continue
		}
		c.mu.Lock()
		c.sampled[id] = SampledStats{ChannelStats: stats, SampledAt: c.now()}
		c.mu.Unlock()
	}
}

// OnPlugin registers a discovery listener; the returned func removes it.
func (c *Client) OnPlugin(listener func(PluginEvent)) func() {
	c.mu.Lock()
	id := c.nextListener
	c.nextListener++
	c.listeners[id] = listener
	c.mu.Unlock()
	return func() {
		c.mu.Lock()
		delete(c.listeners, id)
		c.mu.Unlock()
	}
}

// Close fails the calls in flight, withdraws the subscriptions and closes the connection.
func (c *Client) Close() error {
	c.mu.Lock()
	if c.state == clientClosed {
		c.mu.Unlock()
		return nil
	}
	wasStarted := c.state == clientStarted
	c.state = clientClosed
	if wasStarted {
		close(c.stop)
	}
	for id, p := range c.pending {
		select {
		case p.result <- pendingResult{err: &ConnectionLostError{Message: "client closed; the call may have run"}}:
		default:
		}
		delete(c.pending, id)
	}
	subs := c.subscriptions
	c.subscriptions = nil
	c.mu.Unlock()
	if wasStarted {
		c.loops.Wait()
	}
	c.closeSubscriptions(subs)
	return c.opts.Driver.Close()
}

func (c *Client) declareOnce(ctx context.Context, spec ChannelSpec) error {
	c.mu.Lock()
	done := c.declared[spec.Name]
	c.mu.Unlock()
	if done {
		return nil
	}
	if err := c.opts.Driver.Declare(ctx, []ChannelSpec{spec}); err != nil {
		return err
	}
	c.mu.Lock()
	c.declared[spec.Name] = true
	c.mu.Unlock()
	return nil
}

func (c *Client) sendCancel(pluginID, callID string, cause error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	channel := c.Names.Control(pluginID)
	if err := c.declareOnce(ctx, ControlSpec(channel)); err != nil {
		c.log("warn", "cancel could not be sent", "call", callID, "plugin", pluginID, "error", err.Error())
		return
	}
	attributes := c.codec.Base(HostSource(c.HostInstanceID), CancelType)
	attributes.LfCorrelation = callID
	reason := "aborted by the host"
	if cause != nil && !errors.Is(cause, context.Canceled) {
		reason = cause.Error()
	}
	packed, err := c.codec.Pack(pluginID, attributes, map[string]any{"callId": callID, "reason": reason}, false)
	if err == nil {
		_, err = c.opts.Driver.Publish(ctx, channel, packed.Wire, PublishOptions{TTL: time.Minute})
	}
	if err != nil {
		c.log("warn", "cancel could not be sent", "call", callID, "plugin", pluginID, "error", err.Error())
	}
}

func (c *Client) onReply(wire WireEvent, expectedCallID string) {
	raw, err := c.codec.Peek(wire)
	if err != nil {
		c.log("warn", "dropped a malformed reply", "error", err.Error())
		return
	}
	parsed, ok := ParseType(raw.Attributes.Type)
	correlation := raw.Attributes.LfCorrelation
	if !ok || parsed.Kind != KindResponse || correlation == "" {
		c.log("warn", "dropped a reply that is not a response", "type", raw.Attributes.Type, "id", raw.Attributes.ID)
		return
	}
	if expectedCallID != "" && correlation != expectedCallID {
		c.log("warn", "dropped a native reply with another correlation", "expected", expectedCallID, "correlation", correlation)
		return
	}
	c.mu.Lock()
	pending, ok := c.pending[correlation]
	c.mu.Unlock()
	if !ok {
		c.log("debug", "dropped a reply to a call that is no longer pending", "correlation", correlation)
		return
	}
	pluginID, _, ok := ParsePluginSource(raw.Attributes.Source)
	if !ok || pluginID != pending.pluginID {
		c.log("warn", "dropped a reply from another plugin", "correlation", correlation, "source", raw.Attributes.Source)
		return
	}
	// A reply that went by reference: fetch it, then delete it (the reply channel acknowledges on delivery, so nothing can redeliver it).
	raw, claimKey, err := c.codec.ResolveClaim(context.Background(), raw, pending.pluginID)
	if err != nil {
		var ce *ClaimError
		if errors.As(err, &ce) {
			pending.deliver(pendingResult{err: &ClaimUnavailableError{Message: "the plugin's reply could not be read from the claim store: " + ce.Message, Response: true}})
			return
		}
		c.log("warn", "dropped a reply that failed verification", "correlation", correlation, "error", err.Error())
		return
	}
	if claimKey != "" {
		go c.dropClaim(claimKey)
	}
	opened, err := c.codec.Unpack(raw, pending.pluginID)
	if err != nil {
		if IsDropReason(err) {
			c.log("warn", "dropped a reply that failed verification", "correlation", correlation, "error", err.Error())
			return
		}
		pending.deliver(pendingResult{err: err})
		return
	}
	if parsed.Method != pending.method {
		c.log("warn", "dropped a reply for another method", "correlation", correlation, "type", opened.Attributes.Type)
		return
	}
	pending.deliver(pendingResult{attributes: opened.Attributes, data: opened.Body})
}

// dropClaim deletes a claim object, best effort (the TTL sweeper is the safety net).
func (c *Client) dropClaim(key string) {
	ctx, cancel := context.WithTimeout(context.Background(), claimOperationTimeout)
	defer cancel()
	if err := c.opts.Claims.Delete(ctx, key); err != nil {
		c.log("debug", "could not delete a claim", "key", key, "error", err.Error())
	}
}

func (p *pendingCall) deliver(res pendingResult) {
	select {
	case p.result <- res:
	default:
	}
}

func (c *Client) onRegistry(wire WireEvent) {
	raw, err := c.codec.Peek(wire)
	if err != nil {
		c.log("warn", "dropped a malformed registry event", "error", err.Error())
		return
	}
	parsed, ok := ParseType(raw.Attributes.Type)
	pluginID, instanceID, isPlugin := ParsePluginSource(raw.Attributes.Source)
	if !isPlugin || !ok || (parsed.Kind != KindAnnounce && parsed.Kind != KindWithdraw) {
		return
	}
	opened, err := c.codec.Unpack(raw, pluginID)
	if err != nil {
		c.log("warn", fmt.Sprintf("ignored a %s from %s that failed verification", parsed.Kind, pluginID), "error", err.Error())
		return
	}
	var body AnnounceBody
	if json.Unmarshal(opened.Body, &body) != nil {
		return
	}
	if body.PluginID != pluginID || body.InstanceID != instanceID {
		c.log("warn", "ignored an announce whose body contradicts its source", "source", raw.Attributes.Source)
		return
	}
	if parsed.Kind == KindWithdraw {
		c.forgetInstance(pluginID, instanceID, PluginWithdrawn)
		return
	}
	if c.registrySecret != "" && !VerifyRegistryProof(c.registrySecret, pluginID, raw.Attributes.ID, body.RegistryProof) {
		c.log("warn", fmt.Sprintf("ignored an announce from %s/%s without a valid registry proof", pluginID, instanceID))
		return
	}
	if body.ManifestHash == "" || body.Version == "" {
		return
	}
	now := c.now()
	ttl := body.TTLSeconds
	if ttl <= 0 {
		ttl = DefaultAnnounceTTLSeconds
	}
	c.mu.Lock()
	entry, ok := c.known[pluginID]
	if !ok {
		entry = &knownPlugin{plugin: AnnouncedPlugin{PluginID: pluginID, Version: body.Version, ManifestHash: body.ManifestHash, Endpoint: c.EndpointOf(pluginID), LastSeen: now}, instances: map[string]AnnouncedInstance{}}
		c.known[pluginID] = entry
	}
	_, seen := entry.instances[instanceID]
	changed := entry.plugin.ManifestHash != body.ManifestHash || entry.plugin.Version != body.Version
	entry.instances[instanceID] = AnnouncedInstance{
		InstanceID: instanceID, Version: body.Version, ManifestHash: body.ManifestHash, MaxConcurrency: body.MaxConcurrency, Transports: body.Transports,
		LastSeen: now, ExpiresAt: now.Add(time.Duration(ttl) * time.Second),
	}
	entry.plugin.Version = body.Version
	entry.plugin.ManifestHash = body.ManifestHash
	entry.plugin.LastSeen = now
	entry.refreshLocked()
	plugin := entry.plugin
	c.mu.Unlock()
	if !seen || changed {
		typ := PluginUpdated
		if !seen {
			typ = PluginAnnounced
		}
		c.emit(PluginEvent{Type: typ, Plugin: plugin, InstanceID: instanceID})
	}
}

func (k *knownPlugin) refreshLocked() {
	k.plugin.Instances = make([]AnnouncedInstance, 0, len(k.instances))
	for _, inst := range k.instances {
		k.plugin.Instances = append(k.plugin.Instances, inst)
	}
	sort.Slice(k.plugin.Instances, func(i, j int) bool { return k.plugin.Instances[i].InstanceID < k.plugin.Instances[j].InstanceID })
}

func (c *Client) forgetInstance(pluginID, instanceID string, typ PluginEventType) {
	c.mu.Lock()
	entry, ok := c.known[pluginID]
	if !ok {
		c.mu.Unlock()
		return
	}
	if _, had := entry.instances[instanceID]; !had {
		c.mu.Unlock()
		return
	}
	delete(entry.instances, instanceID)
	entry.refreshLocked()
	plugin := entry.plugin
	c.mu.Unlock()
	c.emit(PluginEvent{Type: typ, Plugin: plugin, InstanceID: instanceID})
}

func (c *Client) expireInstances() {
	now := c.now()
	type gone struct{ plugin, instance string }
	var expired []gone
	c.mu.Lock()
	for pluginID, entry := range c.known {
		for id, inst := range entry.instances {
			if !inst.ExpiresAt.After(now) {
				expired = append(expired, gone{pluginID, id})
			}
		}
	}
	c.mu.Unlock()
	for _, g := range expired {
		c.forgetInstance(g.plugin, g.instance, PluginExpired)
	}
}

func (c *Client) emit(event PluginEvent) {
	c.mu.Lock()
	listeners := make([]func(PluginEvent), 0, len(c.listeners))
	for _, l := range c.listeners {
		listeners = append(listeners, l)
	}
	c.mu.Unlock()
	for _, l := range listeners {
		func() {
			defer func() {
				if r := recover(); r != nil {
					c.log("error", "plugin listener panicked", "panic", fmt.Sprint(r))
				}
			}()
			l(event)
		}()
	}
}
