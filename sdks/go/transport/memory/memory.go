// Package memory is an in-process broker and its driver, for tests and for
// running the core without a broker (the Go mirror of
// @landflow/transports/memory). One Broker is shared by any number of driver
// instances (a "host" and several "plugin replicas" in one process); its
// capabilities are configurable so tests can simulate a broker without headers,
// without native replies, with a small message limit, that cannot report
// undeliverable events, or with latency.
//
// Semantics (the reference every real driver is compared with by the conformance suite):
//   - Work sharing: consumers with the same group compete; each event goes to one
//     of them (round robin among those under their prefetch), FIFO per channel.
//     Consumers without a group each get every event.
//   - Buffering: events published while a channel has no consumer wait (when
//     Buffering) and go to the first consumer that arrives; else they are
//     dropped. With UndeliverableReported, publishing to a channel with no
//     consumer returns Unroutable instead.
//   - Ack/nack/redelivery: Nack(ctx, true) puts the event at the head of its
//     group's queue with attempt+1; closing a subscription (or the driver)
//     requeues its unacknowledged deliveries, like a broker does when a consumer dies.
//   - Native replies (RepliesNative): Request waits for Delivery.Reply; Unroutable with no consumer.
//   - TTL: expired events are dropped when dequeued (when TTL).
//   - Test hooks: Tap sees (and may alter or drop) every event in flight (native
//     replies under "<channel>:reply"); Stats.
//
// Importing the package registers the "memory" driver kind: a URL like
// memory://default builds a driver on the process-wide Default broker.
package memory

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/landflow/landflow/sdks/go/transport"
)

// Kind is the driver kind.
const Kind = "memory"

// DefaultCapabilities are the memory broker's capabilities before Options.Configure.
var DefaultCapabilities = transport.Capabilities{
	Replies: transport.RepliesChannel, WorkSharing: true, Buffering: true, TTL: true, Undeliverable: transport.UndeliverableReported,
	Persistence: transport.PersistenceMemory, MaxMessageBytes: 1024 * 1024, Latency: transport.LatencyLow, Headers: true, OrderingKeys: true, Nack: true, Attempts: true,
}

// Options configures a Broker.
type Options struct {
	// Configure alters the capabilities (nil = DefaultCapabilities).
	Configure func(*transport.Capabilities)
	// Latency delays every delivery (0: a fresh goroutine at once).
	Latency time.Duration
}

// Tap alters or drops (ok false) an event in flight; for tamper and loss tests.
type Tap func(channel string, event transport.WireEvent) (transport.WireEvent, bool)

type message struct {
	event       transport.WireEvent
	attempt     int
	expiresAt   time.Time
	orderingKey string
	replyTo     func(transport.WireEvent) // native request: resolves the requester
}

type consumer struct {
	id       int
	driver   *Driver
	group    string
	opts     transport.ConsumeOptions
	handler  transport.Handler
	inFlight map[*message]bool
	closed   atomic.Bool
	ctx      context.Context
	cancel   context.CancelFunc
	// Deliveries are handed to the handler in order by one dispatch goroutine
	// per consumer: synchronously when the consumer wants no concurrency (auto
	// ack, or prefetch 1), else one goroutine per delivery, up to prefetch.
	qmu    sync.Mutex
	queue  []func()
	signal chan struct{}
}

func (c *consumer) enqueue(run func()) {
	c.qmu.Lock()
	c.queue = append(c.queue, run)
	c.qmu.Unlock()
	select {
	case c.signal <- struct{}{}:
	default:
	}
}

func (c *consumer) dispatchLoop(latency time.Duration) {
	for {
		select {
		case <-c.ctx.Done():
			return
		case <-c.signal:
		}
		for {
			c.qmu.Lock()
			if len(c.queue) == 0 {
				c.qmu.Unlock()
				break
			}
			run := c.queue[0]
			c.queue = c.queue[1:]
			c.qmu.Unlock()
			if latency > 0 {
				time.Sleep(latency)
			}
			if c.opts.AckMode == transport.AckAuto || c.opts.Prefetch <= 1 {
				// No concurrency wanted: call in order, like a broker client's single delivery loop.
				run()
			} else {
				go run()
			}
		}
	}
}

type group struct {
	name      string
	queue     []*message
	consumers []*consumer
	next      int
}

type channel struct {
	spec      *transport.ChannelSpec
	groups    map[string]*group
	broadcast []*consumer
	pending   []*message // waiting for the first consumer
}

// Broker is an in-process broker.
type Broker struct {
	caps        transport.Capabilities
	latency     time.Duration
	mu          sync.Mutex
	channels    map[string]*channel
	taps        map[int]Tap
	nextTap     int
	consumerIDs int
	published   int64
}

var (
	defaultMu     sync.Mutex
	defaultBroker *Broker
)

// Default is the process-wide broker the registered "memory" factory uses.
func Default() *Broker {
	defaultMu.Lock()
	defer defaultMu.Unlock()
	if defaultBroker == nil {
		defaultBroker = NewBroker(Options{})
	}
	return defaultBroker
}

// ResetDefault replaces the process-wide broker (tests).
func ResetDefault() {
	defaultMu.Lock()
	defer defaultMu.Unlock()
	defaultBroker = nil
}

func init() {
	transport.RegisterDriver(Kind, func(connectionID, _ string, opts transport.ConnectionOptions) (transport.Driver, error) {
		return Default().Driver(transport.Config{ConnectionID: connectionID, Prefix: opts.Prefix}), nil
	})
}

// NewBroker builds a broker.
func NewBroker(opts Options) *Broker {
	caps := DefaultCapabilities
	if opts.Configure != nil {
		opts.Configure(&caps)
	}
	return &Broker{caps: caps, latency: opts.Latency, channels: map[string]*channel{}, taps: map[int]Tap{}}
}

// Capabilities are the broker's (and every driver's) capabilities.
func (b *Broker) Capabilities() transport.Capabilities { return b.caps }

// Driver is a new, unconnected driver on this broker. cfg.ConnectionID "" = "memory".
func (b *Broker) Driver(cfg transport.Config) *Driver {
	if cfg.ConnectionID == "" {
		cfg.ConnectionID = Kind
	}
	return &Driver{broker: b, cfg: cfg, subscriptions: map[*subscription]bool{}}
}

// Tap adds a tap; the returned func removes it.
func (b *Broker) Tap(tap Tap) func() {
	b.mu.Lock()
	id := b.nextTap
	b.nextTap++
	b.taps[id] = tap
	b.mu.Unlock()
	return func() {
		b.mu.Lock()
		delete(b.taps, id)
		b.mu.Unlock()
	}
}

// Published counts events accepted by Publish/Request so far.
func (b *Broker) Published() int64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.published
}

func (b *Broker) channelLocked(name string) *channel {
	ch, ok := b.channels[name]
	if !ok {
		ch = &channel{groups: map[string]*group{}}
		b.channels[name] = ch
	}
	return ch
}

// Stats reports depth and consumers of a channel.
func (b *Broker) Stats(name string) transport.ChannelStats {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.statsLocked(name)
}

func (b *Broker) statsLocked(name string) transport.ChannelStats {
	ch, ok := b.channels[name]
	if !ok {
		return transport.ChannelStats{Depth: transport.Int(0), Consumers: transport.Int(0)}
	}
	depth := len(ch.pending)
	consumers := len(ch.broadcast)
	for _, g := range ch.groups {
		if len(g.queue) > depth {
			depth = len(g.queue)
		}
		consumers += len(g.consumers)
	}
	return transport.ChannelStats{Depth: transport.Int(depth), Consumers: transport.Int(consumers)}
}

func (b *Broker) hasConsumersLocked(name string) bool { return *b.statsLocked(name).Consumers > 0 }

func clone(event transport.WireEvent) transport.WireEvent {
	headers := make(map[string]string, len(event.Headers))
	for k, v := range event.Headers {
		headers[k] = v
	}
	return transport.WireEvent{Headers: headers, Body: append([]byte(nil), event.Body...)}
}

func (b *Broker) applyTaps(name string, event transport.WireEvent) (transport.WireEvent, bool) {
	b.mu.Lock()
	taps := make([]Tap, 0, len(b.taps))
	for _, t := range b.taps {
		taps = append(taps, t)
	}
	b.mu.Unlock()
	carried := clone(event)
	for _, tap := range taps {
		var ok bool
		if carried, ok = tap(name, carried); !ok {
			return transport.WireEvent{}, false
		}
	}
	return carried, true
}

func (b *Broker) publish(name string, event transport.WireEvent, opts transport.PublishOptions, replyTo func(transport.WireEvent)) (transport.PublishOutcome, error) {
	size := transport.SizeOf(event).TotalBytes
	if size > b.caps.MaxMessageBytes {
		return "", fmt.Errorf("memory: message of %d bytes exceeds the broker limit of %d", size, b.caps.MaxMessageBytes)
	}
	carried, ok := b.applyTaps(name, event)
	if !ok {
		return transport.Accepted, nil
	}
	if !b.caps.Headers {
		// A broker without headers carries only the body; keep content-type so decoding is unambiguous, drop the rest.
		headers := map[string]string{}
		if ct, ok := carried.Headers["content-type"]; ok {
			headers["content-type"] = ct
		}
		carried = transport.WireEvent{Headers: headers, Body: carried.Body}
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	ch := b.channelLocked(name)
	msg := &message{event: carried, attempt: 1, orderingKey: opts.OrderingKey, replyTo: replyTo}
	if b.caps.TTL && opts.TTL > 0 {
		msg.expiresAt = time.Now().Add(opts.TTL)
	}
	if !b.hasConsumersLocked(name) {
		if b.caps.Undeliverable == transport.UndeliverableReported {
			return transport.Unroutable, nil
		}
		if b.caps.Buffering {
			ch.pending = append(ch.pending, msg)
		}
		b.published++
		return transport.Accepted, nil
	}
	b.published++
	for _, c := range ch.broadcast {
		copy := *msg
		copy.event = clone(msg.event)
		b.deliverLocked(c, &copy, nil)
	}
	for _, g := range ch.groups {
		m := msg
		if len(ch.groups) > 1 {
			copy := *msg
			copy.event = clone(msg.event)
			m = &copy
		}
		g.queue = append(g.queue, m)
		b.pumpLocked(g)
	}
	return transport.Accepted, nil
}

func (b *Broker) consume(d *Driver, name string, opts transport.ConsumeOptions, handler transport.Handler) *consumer {
	b.mu.Lock()
	defer b.mu.Unlock()
	ch := b.channelLocked(name)
	b.consumerIDs++
	ctx, cancel := context.WithCancel(context.Background())
	c := &consumer{id: b.consumerIDs, driver: d, opts: opts, handler: handler, inFlight: map[*message]bool{}, ctx: ctx, cancel: cancel, signal: make(chan struct{}, 1)}
	go c.dispatchLoop(b.latency)
	if b.caps.WorkSharing {
		c.group = opts.Group
	}
	if c.group != "" {
		g, ok := ch.groups[c.group]
		if !ok {
			g = &group{name: name}
			ch.groups[c.group] = g
		}
		g.consumers = append(g.consumers, c)
		if len(ch.pending) > 0 {
			g.queue = append(g.queue, ch.pending...)
			ch.pending = nil
		}
		b.pumpLocked(g)
	} else {
		ch.broadcast = append(ch.broadcast, c)
		pending := ch.pending
		ch.pending = nil
		for _, m := range pending {
			b.deliverLocked(c, m, nil)
		}
	}
	return c
}

func (b *Broker) unsubscribe(name string, c *consumer) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if c.closed.Swap(true) {
		return
	}
	c.cancel()
	ch := b.channelLocked(name)
	if c.group != "" {
		g, ok := ch.groups[c.group]
		if !ok {
			return
		}
		g.consumers = removeConsumer(g.consumers, c)
		// The consumer died: what it held goes back for the others.
		for m := range c.inFlight {
			re := *m
			re.attempt = m.attempt + 1
			g.queue = append([]*message{&re}, g.queue...)
		}
		c.inFlight = map[*message]bool{}
		if len(g.consumers) == 0 {
			ch.pending = append(ch.pending, g.queue...)
			delete(ch.groups, c.group)
		} else {
			b.pumpLocked(g)
		}
	} else {
		ch.broadcast = removeConsumer(ch.broadcast, c)
	}
}

func removeConsumer(list []*consumer, c *consumer) []*consumer {
	out := list[:0]
	for _, x := range list {
		if x != c {
			out = append(out, x)
		}
	}
	return out
}

func (b *Broker) pumpLocked(g *group) {
	for len(g.queue) > 0 {
		var candidates []*consumer
		for _, c := range g.consumers {
			if !c.closed.Load() && len(c.inFlight) < c.opts.Prefetch {
				candidates = append(candidates, c)
			}
		}
		if len(candidates) == 0 {
			return
		}
		m := g.queue[0]
		g.queue = g.queue[1:]
		if !m.expiresAt.IsZero() && !m.expiresAt.After(time.Now()) {
			continue
		}
		c := candidates[g.next%len(candidates)]
		g.next++
		b.deliverLocked(c, m, g)
	}
}

type delivery struct {
	broker  *Broker
	c       *consumer
	m       *message
	g       *group
	manual  bool
	settled bool
	mu      sync.Mutex
}

func (d *delivery) Attempt() int { return d.m.attempt }

// settle returns true the first time, under the broker lock.
func (d *delivery) settleLocked() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.settled {
		return false
	}
	d.settled = true
	delete(d.c.inFlight, d.m)
	return true
}

func (d *delivery) Ack(context.Context) error {
	if !d.manual {
		return nil
	}
	d.broker.mu.Lock()
	defer d.broker.mu.Unlock()
	if d.settleLocked() && d.g != nil {
		d.broker.pumpLocked(d.g)
	}
	return nil
}

func (d *delivery) Nack(_ context.Context, requeue bool) error {
	if !d.manual {
		return nil
	}
	d.broker.mu.Lock()
	defer d.broker.mu.Unlock()
	if !d.settleLocked() || d.g == nil {
		return nil
	}
	if requeue && d.broker.caps.Nack {
		re := *d.m
		re.attempt = d.m.attempt + 1
		d.g.queue = append([]*message{&re}, d.g.queue...)
	}
	d.broker.pumpLocked(d.g)
	return nil
}

// nativeDelivery adds Reply for RepliesNative brokers.
type nativeDelivery struct{ *delivery }

func (d nativeDelivery) Reply(_ context.Context, event transport.WireEvent) error {
	name := ""
	if d.g != nil {
		name = d.g.name
	}
	carried, ok := d.broker.applyTaps(name+":reply", event)
	if !ok || d.m.replyTo == nil {
		return nil
	}
	d.m.replyTo(carried)
	return nil
}

func (b *Broker) deliverLocked(c *consumer, m *message, g *group) {
	manual := c.opts.AckMode == transport.AckManual && g != nil
	if manual {
		c.inFlight[m] = true
	}
	d := &delivery{broker: b, c: c, m: m, g: g, manual: manual}
	var del transport.Delivery = d
	if b.caps.Replies == transport.RepliesNative {
		del = nativeDelivery{d}
	}
	run := func() {
		if c.closed.Load() || !c.driver.isConnected() {
			return
		}
		func() {
			defer func() {
				if r := recover(); r != nil {
					_ = d.Nack(context.Background(), false)
				}
			}()
			c.handler(c.ctx, clone(m.event), del)
		}()
	}
	c.enqueue(run)
}

// Driver is a memory driver: one "connection" to a Broker.
type Driver struct {
	broker        *Broker
	cfg           transport.Config
	mu            sync.Mutex
	connected     bool
	subscriptions map[*subscription]bool
}

var _ transport.Driver = (*Driver)(nil)
var _ transport.Requester = (*Driver)(nil)
var _ transport.StatsReporter = (*Driver)(nil)

func (d *Driver) Kind() string                         { return Kind }
func (d *Driver) Capabilities() transport.Capabilities { return d.broker.caps }
func (d *Driver) Config() transport.Config             { return d.cfg }

// Broker is the broker this driver is on.
func (d *Driver) Broker() *Broker { return d.broker }

func (d *Driver) isConnected() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.connected
}

func (d *Driver) ensureConnected() error {
	if !d.isConnected() {
		return fmt.Errorf("memory driver: %w", transport.ErrNotConnected)
	}
	return nil
}

func (d *Driver) Connect(context.Context) error {
	d.mu.Lock()
	d.connected = true
	d.mu.Unlock()
	return nil
}

func (d *Driver) Declare(_ context.Context, specs []transport.ChannelSpec) error {
	if err := d.ensureConnected(); err != nil {
		return err
	}
	d.broker.mu.Lock()
	defer d.broker.mu.Unlock()
	for i := range specs {
		spec := specs[i]
		d.broker.channelLocked(spec.Name).spec = &spec
	}
	return nil
}

func (d *Driver) Publish(_ context.Context, channel string, event transport.WireEvent, opts transport.PublishOptions) (transport.PublishOutcome, error) {
	if err := d.ensureConnected(); err != nil {
		return "", err
	}
	return d.broker.publish(channel, event, opts, nil)
}

// Request is the native request/reply (only meaningful when Replies is RepliesNative).
func (d *Driver) Request(ctx context.Context, channel string, event transport.WireEvent, opts transport.RequestOptions) (transport.RequestResult, error) {
	if err := d.ensureConnected(); err != nil {
		return transport.RequestResult{}, err
	}
	replies := make(chan transport.WireEvent, 1)
	outcome, err := d.broker.publish(channel, event, transport.PublishOptions{OrderingKey: opts.OrderingKey, TTL: opts.Timeout}, func(reply transport.WireEvent) {
		select {
		case replies <- reply:
		default:
		}
	})
	if err != nil {
		return transport.RequestResult{}, err
	}
	if outcome == transport.Unroutable {
		return transport.RequestResult{Outcome: transport.RequestUnroutable}, nil
	}
	timer := time.NewTimer(opts.Timeout)
	defer timer.Stop()
	select {
	case reply := <-replies:
		return transport.RequestResult{Outcome: transport.RequestReplied, Event: reply}, nil
	case <-timer.C:
		return transport.RequestResult{Outcome: transport.RequestTimeout}, nil
	case <-ctx.Done():
		return transport.RequestResult{Outcome: transport.RequestTimeout}, nil
	}
}

type subscription struct {
	driver   *Driver
	channel  string
	consumer *consumer
}

func (s *subscription) Channel() string { return s.channel }

func (s *subscription) Close(context.Context) error {
	s.driver.broker.unsubscribe(s.channel, s.consumer)
	s.driver.mu.Lock()
	delete(s.driver.subscriptions, s)
	s.driver.mu.Unlock()
	return nil
}

func (d *Driver) Consume(_ context.Context, channel string, opts transport.ConsumeOptions, handler transport.Handler) (transport.Subscription, error) {
	if err := d.ensureConnected(); err != nil {
		return nil, err
	}
	if opts.Prefetch <= 0 {
		opts.Prefetch = 1
	}
	c := d.broker.consume(d, channel, opts, handler)
	sub := &subscription{driver: d, channel: channel, consumer: c}
	d.mu.Lock()
	d.subscriptions[sub] = true
	d.mu.Unlock()
	return sub, nil
}

func (d *Driver) Stats(_ context.Context, channel string) (transport.ChannelStats, error) {
	if err := d.ensureConnected(); err != nil {
		return transport.ChannelStats{}, err
	}
	return d.broker.Stats(channel), nil
}

// Close disconnects; unacknowledged deliveries go back to the broker. Idempotent.
func (d *Driver) Close() error {
	d.mu.Lock()
	d.connected = false
	subs := make([]*subscription, 0, len(d.subscriptions))
	for s := range d.subscriptions {
		subs = append(subs, s)
	}
	d.mu.Unlock()
	for _, s := range subs {
		_ = s.Close(context.Background())
	}
	return nil
}
