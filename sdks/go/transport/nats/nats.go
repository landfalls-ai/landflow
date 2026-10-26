// Package nats is the NATS driver of sdks/go/transport (docs/transports.md
// "Brokers", docs/protocol.md §14.9), built on github.com/nats-io/nats.go. It
// registers two kinds, like the TypeScript drivers (@landflow/transports/nats
// and /jetstream), because their capabilities differ:
//
//   - "nats" (core, the default): a subject per channel, a queue group for work
//     sharing, native request/reply through inboxes, "no responders" reported as
//     unroutable (for requests, and for publishes through a reply inbox + flush).
//     Nothing is buffered or persisted; a nack with requeue republishes the event
//     with the next attempt number (Landflow-Attempt header) and the requester's
//     inbox (Landflow-Reply header).
//   - "jetstream" (Config.JetStream): durable request channels become a
//     work-queue stream (max age = the channel TTL, else Config.MaxAge) with a
//     durable pull consumer named after the group, so events are buffered,
//     acknowledged (ack / nak = requeue / term), redelivered after Config.AckWait
//     (running calls send progress acks) and counted (NumDelivered). Replies stay
//     native: the requester's inbox travels in the Landflow-Reply header. The
//     other channels (instance, reply, registry, control) stay core subjects.
//
// In jetstream mode every subject is the channel name behind a fixed "js." token (js.landflow.v1.plugin.<id>; stream
// js_landflow_v1_plugin_<id>), so it never collides with a "nats" driver on the same server and prefix.
//
// CloudEvents attributes are `ce-` headers (binary mode); `content-type` is the
// Content-Type header. The driver headers above are never shown to the core.
//
// This package is its own Go module so sdks/go stays free of nats.go. Code use:
// nats.New(nats.Config{URL: "nats://127.0.0.1:54222"}) or
// nats.New(nats.Config{URL: …, JetStream: true}); env use: blank-import the
// package and set LANDFLOW_NATS_URL or LANDFLOW_JETSTREAM_URL (plus
// LANDFLOW_<KIND>_USERNAME / _PASSWORD, _TLS=true, _PREFIX; JetStream also
// _STREAMPREFIX and _ACKWAITMS).
package nats

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	natsgo "github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/landflow/landflow/sdks/go/transport"
)

// Kinds this package registers.
const (
	Kind          = "nats"
	KindJetStream = "jetstream"
)

// HeaderPrefix is the NATS protocol binding's prefix for CloudEvents attributes.
const HeaderPrefix = "ce-"

// Driver headers shared with the TypeScript driver (never shown to the core:
// UnprefixHeaders keeps only ce- headers and content-type).
const (
	// replyHeader carries the requester's inbox when the NATS reply subject
	// cannot (a stored JetStream message's own reply is the ack subject; a
	// republished core event has none).
	replyHeader = "Landflow-Reply"
	// attemptHeader is the delivery attempt of a republished core event.
	attemptHeader = "Landflow-Attempt"
)

// requeueDelay is the delay of a JetStream nak, so a draining replica does not spin on an event.
const requeueDelay = 25 * time.Millisecond

// ttlHeader is NATS's per-message TTL (server 2.11+, streams with allow_msg_ttl); whole seconds, minimum 1.
const ttlHeader = "Nats-TTL"

func ttlHeaderValue(d time.Duration) string {
	secs := int64((d + time.Second - 1) / time.Second)
	return strconv.FormatInt(max(secs, 1), 10) + "s"
}

// Config configures a NATS driver.
type Config struct {
	transport.Config
	// URL is the server URL ("nats://127.0.0.1:54222"; several comma-separated).
	URL string
	// TLS, when set, is used for the connection.
	TLS *tls.Config
	// Username / Password for user/password authentication.
	Username, Password string
	// JetStream: the "jetstream" kind (see the package doc).
	JetStream bool
	// StreamPrefix is prepended to the names of the streams this connection creates (default none).
	StreamPrefix string
	// AckWait is the JetStream ack wait of request consumers (default 30 s);
	// running calls send progress acks every AckWait/3.
	AckWait time.Duration
	// MaxAge is the retention of request streams declared without a TTL (default 1 h).
	MaxAge time.Duration
	// MaxMessageBytes the server accepts (default 1 MiB, max_payload).
	MaxMessageBytes int
	// Name is the connection name shown by the server (default "landflow").
	Name string
}

// Driver is one NATS connection.
type Driver struct {
	cfg  Config
	caps transport.Capabilities

	mu      sync.Mutex
	nc      *natsgo.Conn
	js      jetstream.JetStream
	closed  bool
	streams map[string]streamKnown // channels known to be (or not) served by a stream
	subs    map[*subscription]struct{}
}

// New returns an unconnected driver; defaults are filled in.
func New(cfg Config) *Driver {
	if cfg.URL == "" {
		cfg.URL = natsgo.DefaultURL
	}
	if cfg.AckWait <= 0 {
		cfg.AckWait = 30 * time.Second
	}
	if cfg.MaxAge <= 0 {
		cfg.MaxAge = time.Hour
	}
	if cfg.MaxMessageBytes <= 0 {
		cfg.MaxMessageBytes = 1 << 20
	}
	if cfg.Name == "" {
		cfg.Name = "landflow"
	}
	if cfg.Prefix == "" {
		cfg.Prefix = transport.DefaultPrefix
	}
	caps := transport.Capabilities{
		Replies:         transport.RepliesNative,
		WorkSharing:     true,
		Buffering:       false,
		TTL:             false,
		Undeliverable:   transport.UndeliverableReported,
		Persistence:     transport.PersistenceMemory,
		MaxMessageBytes: cfg.MaxMessageBytes,
		Latency:         transport.LatencyLow,
		Headers:         true,
		OrderingKeys:    false,
		Nack:            true,
		Attempts:        true,
	}
	if cfg.JetStream {
		caps.Buffering = true
		caps.Undeliverable = transport.UndeliverableInferred
		caps.Persistence = transport.PersistenceDisk
	}
	return &Driver{cfg: cfg, caps: caps, streams: map[string]streamKnown{}, subs: map[*subscription]struct{}{}}
}

func init() {
	for _, kind := range []string{Kind, KindJetStream} {
		kind := kind
		transport.RegisterDriver(kind, func(connectionID, rawURL string, opts transport.ConnectionOptions) (transport.Driver, error) {
			cfg, err := ConfigFromURL(connectionID, rawURL, opts)
			if err != nil {
				return nil, err
			}
			cfg.JetStream = kind == KindJetStream
			return New(cfg), nil
		})
	}
}

// ConfigFromURL builds a Config from nats:// (or tls://) URLs and the
// connection options; fields: jetstream (true|false), streamprefix, ackwaitms, maxagems.
func ConfigFromURL(connectionID, rawURL string, opts transport.ConnectionOptions) (Config, error) {
	raw := strings.TrimSpace(rawURL)
	if raw == "" {
		return Config{}, errors.New("nats: empty URL (want nats://host:port)")
	}
	for _, one := range strings.Split(raw, ",") {
		u, err := url.Parse(strings.TrimSpace(one))
		if err != nil || u.Host == "" {
			return Config{}, fmt.Errorf("nats: malformed URL %q (want nats://host:port)", one)
		}
		switch strings.ToLower(u.Scheme) {
		case "nats", "tls", "ws", "wss":
		default:
			return Config{}, fmt.Errorf("nats: unsupported URL scheme %q", u.Scheme)
		}
	}
	cfg := Config{
		Config:   transport.Config{ConnectionID: connectionID, Prefix: opts.Prefix},
		URL:      raw,
		Username: opts.Username, Password: opts.Password,
		StreamPrefix: opts.Fields["streamprefix"],
	}
	if opts.TLS {
		cfg.TLS = &tls.Config{MinVersion: tls.VersionTLS12}
	}
	switch js := strings.ToLower(opts.Fields["jetstream"]); js {
	case "", "false", "0", "no", "off":
	case "true", "1", "yes", "on":
		cfg.JetStream = true
	default:
		return Config{}, fmt.Errorf("nats: jetstream %q must be true or false", js)
	}
	for field, dst := range map[string]*time.Duration{"ackwaitms": &cfg.AckWait, "maxagems": &cfg.MaxAge} {
		if raw := opts.Fields[field]; raw != "" {
			ms, err := strconv.Atoi(raw)
			if err != nil || ms <= 0 {
				return Config{}, fmt.Errorf("nats: %s %q must be a positive integer", field, raw)
			}
			*dst = time.Duration(ms) * time.Millisecond
		}
	}
	return cfg, nil
}

// Kind implements transport.Driver: "nats" or "jetstream".
func (d *Driver) Kind() string {
	if d.cfg.JetStream {
		return KindJetStream
	}
	return Kind
}

// Capabilities implements transport.Driver.
func (d *Driver) Capabilities() transport.Capabilities { return d.caps }

// Config implements transport.Driver.
func (d *Driver) Config() transport.Config { return d.cfg.Config }

// NATSConfig returns the full driver configuration.
func (d *Driver) NATSConfig() Config { return d.cfg }

// Connect implements transport.Driver.
func (d *Driver) Connect(ctx context.Context) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return fmt.Errorf("nats: driver closed: %w", transport.ErrNotConnected)
	}
	if d.nc != nil {
		return nil
	}
	opts := []natsgo.Option{natsgo.Name(d.cfg.Name), natsgo.MaxReconnects(-1), natsgo.RetryOnFailedConnect(false)}
	if deadline, ok := ctx.Deadline(); ok {
		opts = append(opts, natsgo.Timeout(time.Until(deadline)))
	}
	if d.cfg.TLS != nil {
		opts = append(opts, natsgo.Secure(d.cfg.TLS))
	}
	if d.cfg.Username != "" {
		opts = append(opts, natsgo.UserInfo(d.cfg.Username, d.cfg.Password))
	}
	nc, err := natsgo.Connect(d.cfg.URL, opts...)
	if err != nil {
		return fmt.Errorf("nats: connect %s: %w", d.cfg.URL, err)
	}
	if d.cfg.JetStream {
		js, err := jetstream.New(nc)
		if err != nil {
			nc.Close()
			return fmt.Errorf("nats: jetstream: %w", err)
		}
		if _, err := js.AccountInfo(ctx); err != nil {
			nc.Close()
			return fmt.Errorf("nats: jetstream is not enabled on %s: %w", d.cfg.URL, err)
		}
		d.js = js
	}
	d.nc = nc
	return nil
}

func (d *Driver) conn() (*natsgo.Conn, jetstream.JetStream, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.nc == nil || d.nc.IsClosed() {
		return nil, nil, fmt.Errorf("nats: %w", transport.ErrNotConnected)
	}
	return d.nc, d.js, nil
}

// StreamName is the JetStream stream name of a channel: the stream prefix plus
// the channel with dots replaced by underscores (as the TS driver names them).
func StreamName(channel, prefix string) string { return prefix + strings.ReplaceAll(channel, ".", "_") }

// SubjectToken is the token jetstream mode puts in front of every channel name, so the two NATS kinds never share a
// subject on one server (a work-queue stream would otherwise capture what core "nats" publishes).
const SubjectToken = "js"

// subjectOf is the NATS subject of a channel: the channel itself for "nats", "js.<channel>" for "jetstream"
// (stream subjects, consumer filters, publishes and core subscriptions alike).
func (d *Driver) subjectOf(channel string) string {
	if d.cfg.JetStream {
		return SubjectToken + "." + channel
	}
	return channel
}

// channelOf maps a subject produced by subjectOf back to its channel name.
func (d *Driver) channelOf(subject string) string {
	if d.cfg.JetStream {
		return strings.TrimPrefix(subject, SubjectToken+".")
	}
	return subject
}

func (d *Driver) streamName(channel string) string {
	return StreamName(d.subjectOf(channel), d.cfg.StreamPrefix)
}

// streamKnown caches whether a stream serves a channel (a miss is re-checked after a while: another instance may declare it).
type streamKnown struct {
	yes     bool
	checked time.Time
}

// isStream reports whether a channel is served by a JetStream stream: one this
// driver declared durable, or one another instance declared (looked up by
// subject on the server and cached), so every instance agrees.
func (d *Driver) isStream(channel string) bool {
	if !d.cfg.JetStream {
		return false
	}
	d.mu.Lock()
	known, ok := d.streams[channel]
	js := d.js
	d.mu.Unlock()
	if ok && (known.yes || time.Since(known.checked) < 5*time.Second) {
		return known.yes
	}
	if js == nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := js.StreamNameBySubject(ctx, d.subjectOf(channel))
	yes := err == nil
	d.mu.Lock()
	d.streams[channel] = streamKnown{yes: yes, checked: time.Now()}
	d.mu.Unlock()
	return yes
}

// Declare implements transport.Driver. Core subjects need no declaration; in
// JetStream mode a durable channel gets a work-queue stream (idempotent).
func (d *Driver) Declare(ctx context.Context, channels []transport.ChannelSpec) error {
	_, js, err := d.conn()
	if err != nil {
		return err
	}
	for _, spec := range channels {
		if !d.cfg.JetStream || !spec.Durable {
			continue
		}
		maxAge := spec.TTL
		if maxAge <= 0 {
			maxAge = d.cfg.MaxAge
		}
		cfg := jetstream.StreamConfig{
			Name: d.streamName(spec.Name), Subjects: []string{d.subjectOf(spec.Name)},
			Retention: jetstream.WorkQueuePolicy, Storage: jetstream.FileStorage, Discard: jetstream.DiscardOld,
			MaxAge: maxAge, MaxMsgSize: int32(d.cfg.MaxMessageBytes),
			AllowMsgTTL: true, // per-message Nats-TTL as a first filter (the TS driver sets it the same way)
		}
		if _, err := js.CreateOrUpdateStream(ctx, cfg); err != nil {
			return fmt.Errorf("nats: declare stream for %s: %w", spec.Name, err)
		}
		d.mu.Lock()
		d.streams[spec.Name] = streamKnown{yes: true, checked: time.Now()}
		d.mu.Unlock()
	}
	return nil
}

// flush waits for the server to process what was sent; nats.go needs a deadline.
func flush(ctx context.Context, nc *natsgo.Conn) error {
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
	}
	return nc.FlushWithContext(ctx)
}

func newMsg(subject string, event transport.WireEvent) *natsgo.Msg {
	msg := natsgo.NewMsg(subject)
	msg.Data = event.Body
	for name, value := range transport.PrefixHeaders(event.Headers, HeaderPrefix) {
		if name == "content-type" {
			msg.Header.Set("Content-Type", value)
		} else {
			msg.Header.Set(name, value)
		}
	}
	return msg
}

func wireEvent(header natsgo.Header, data []byte) transport.WireEvent {
	headers := make(map[string]string, len(header))
	for name, values := range header {
		if len(values) > 0 {
			headers[name] = values[0]
		}
	}
	if ct := header.Get("Content-Type"); ct != "" {
		headers["content-type"] = ct
	}
	return transport.WireEvent{Headers: transport.UnprefixHeaders(headers, HeaderPrefix), Body: data}
}

// replyOf is the requester's inbox: the driver header wins over the NATS reply subject.
func replyOf(header natsgo.Header, reply string) string {
	if r := header.Get(replyHeader); r != "" {
		return r
	}
	return reply
}

// Publish implements transport.Driver. Core: published with a reply inbox and
// flushed, so the server's "no responders" status (which precedes the flush's
// PONG) tells whether anyone took it. JetStream: waits for the stream's ack;
// unroutable when no stream takes the subject.
func (d *Driver) Publish(ctx context.Context, channel string, event transport.WireEvent, opts transport.PublishOptions) (transport.PublishOutcome, error) {
	nc, js, err := d.conn()
	if err != nil {
		return "", err
	}
	msg := newMsg(d.subjectOf(channel), event)
	if d.isStream(channel) {
		if opts.TTL > 0 {
			msg.Header.Set(ttlHeader, ttlHeaderValue(opts.TTL))
		}
		if _, err := js.PublishMsg(ctx, msg); err != nil {
			if errors.Is(err, jetstream.ErrNoStreamResponse) {
				return transport.Unroutable, nil
			}
			return "", fmt.Errorf("nats: publish to %s: %w", channel, err)
		}
		return transport.Accepted, nil
	}
	// Publish with a reply inbox of ours and flush: the server answers a publish nobody subscribes to with a 503 on
	// that inbox before it answers the flush's PING, so one round trip tells whether anyone took it (nats.go hands the
	// status to a synchronous subscription as ErrNoResponders).
	inbox := nc.NewRespInbox()
	sub, err := nc.SubscribeSync(inbox)
	if err != nil {
		return "", fmt.Errorf("nats: publish to %s: %w", channel, err)
	}
	defer sub.Unsubscribe()
	msg.Reply = inbox
	if err := nc.PublishMsg(msg); err != nil {
		if errors.Is(err, natsgo.ErrConnectionClosed) {
			return "", fmt.Errorf("nats: %w", transport.ErrNotConnected)
		}
		return "", fmt.Errorf("nats: publish to %s: %w", channel, err)
	}
	if err := flush(ctx, nc); err != nil {
		return "", fmt.Errorf("nats: publish to %s: %w", channel, err)
	}
	if _, err := sub.NextMsg(time.Millisecond); errors.Is(err, natsgo.ErrNoResponders) {
		return transport.Unroutable, nil
	}
	return transport.Accepted, nil
}

// Request implements transport.Requester: a core request (no responders =
// unroutable), or, for a stream, a publish carrying the inbox in the
// Landflow-Reply header with the reply awaited on that inbox.
func (d *Driver) Request(ctx context.Context, channel string, event transport.WireEvent, opts transport.RequestOptions) (transport.RequestResult, error) {
	nc, js, err := d.conn()
	if err != nil {
		return transport.RequestResult{}, err
	}
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	rctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	msg := newMsg(d.subjectOf(channel), event)
	if !d.isStream(channel) {
		reply, err := nc.RequestMsgWithContext(rctx, msg)
		switch {
		case err == nil:
			return transport.RequestResult{Outcome: transport.RequestReplied, Event: wireEvent(reply.Header, reply.Data)}, nil
		case errors.Is(err, natsgo.ErrNoResponders):
			return transport.RequestResult{Outcome: transport.RequestUnroutable}, nil
		case errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil:
			return transport.RequestResult{Outcome: transport.RequestTimeout}, nil
		case errors.Is(err, natsgo.ErrConnectionClosed):
			return transport.RequestResult{}, fmt.Errorf("nats: %w", transport.ErrNotConnected)
		default:
			return transport.RequestResult{}, fmt.Errorf("nats: request to %s: %w", channel, err)
		}
	}
	inbox := nc.NewRespInbox()
	sub, err := nc.SubscribeSync(inbox)
	if err != nil {
		return transport.RequestResult{}, fmt.Errorf("nats: request inbox: %w", err)
	}
	defer sub.Unsubscribe()
	msg.Header.Set(replyHeader, inbox)
	msg.Header.Set(ttlHeader, ttlHeaderValue(timeout))
	if _, err := js.PublishMsg(rctx, msg); err != nil {
		if errors.Is(err, jetstream.ErrNoStreamResponse) {
			return transport.RequestResult{Outcome: transport.RequestUnroutable}, nil
		}
		return transport.RequestResult{}, fmt.Errorf("nats: publish to %s: %w", channel, err)
	}
	reply, err := sub.NextMsgWithContext(rctx)
	switch {
	case err == nil:
		return transport.RequestResult{Outcome: transport.RequestReplied, Event: wireEvent(reply.Header, reply.Data)}, nil
	case errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil:
		return transport.RequestResult{Outcome: transport.RequestTimeout}, nil
	default:
		return transport.RequestResult{}, fmt.Errorf("nats: request to %s: %w", channel, err)
	}
}

// Consume implements transport.Driver.
func (d *Driver) Consume(ctx context.Context, channel string, opts transport.ConsumeOptions, handler transport.Handler) (transport.Subscription, error) {
	nc, js, err := d.conn()
	if err != nil {
		return nil, err
	}
	prefetch := max(opts.Prefetch, 1)
	runCtx, cancel := context.WithCancel(context.Background())
	s := &subscription{d: d, channel: channel, cancel: cancel, done: make(chan struct{}), held: map[requeuer]struct{}{}}
	slots := make(chan struct{}, prefetch)
	manual := opts.AckMode != transport.AckAuto && opts.Group != ""
	if d.isStream(channel) && opts.Group != "" {
		consumer, err := js.CreateOrUpdateConsumer(ctx, d.streamName(channel), jetstream.ConsumerConfig{
			Durable: StreamName(opts.Group, ""), FilterSubject: d.subjectOf(channel),
			AckPolicy: jetstream.AckExplicitPolicy, AckWait: d.cfg.AckWait, MaxAckPending: -1, MaxDeliver: -1,
			DeliverPolicy: jetstream.DeliverAllPolicy,
		})
		if err != nil {
			cancel()
			return nil, fmt.Errorf("nats: consumer for %s: %w", channel, err)
		}
		progress := max(time.Second, d.cfg.AckWait/3)
		cc, err := consumer.Consume(func(msg jetstream.Msg) {
			slots <- struct{}{}
			del := &jsDelivery{nc: nc, msg: msg, slots: slots, done: make(chan struct{}), sub: s}
			if !manual {
				_ = del.Ack(runCtx)
			} else {
				s.hold(del)
				go del.keepAlive(runCtx, progress)
			}
			go handler(runCtx, wireEvent(msg.Headers(), msg.Data()), del)
		}, jetstream.PullMaxMessages(prefetch))
		if err != nil {
			cancel()
			return nil, fmt.Errorf("nats: consume %s: %w", channel, err)
		}
		s.stop = func() { cc.Stop() }
	} else {
		deliver := func(msg *natsgo.Msg) {
			slots <- struct{}{}
			del := &coreDelivery{nc: nc, msg: msg, slots: slots, sub: s}
			if !manual {
				del.settled.Store(true)
				go func() {
					defer func() { <-slots }()
					handler(runCtx, wireEvent(msg.Header, msg.Data), del)
				}()
				return
			}
			s.hold(del)
			go handler(runCtx, wireEvent(msg.Header, msg.Data), del)
		}
		var sub *natsgo.Subscription
		if opts.Group != "" {
			sub, err = nc.QueueSubscribe(d.subjectOf(channel), opts.Group, deliver)
		} else {
			sub, err = nc.Subscribe(d.subjectOf(channel), deliver)
		}
		if err != nil {
			cancel()
			return nil, fmt.Errorf("nats: subscribe %s: %w", channel, err)
		}
		_ = sub.SetPendingLimits(-1, -1)
		s.stop = func() { _ = sub.Unsubscribe() }
	}
	if err := flush(ctx, nc); err != nil {
		s.stop()
		cancel()
		return nil, fmt.Errorf("nats: subscribe %s: %w", channel, err)
	}
	d.mu.Lock()
	d.subs[s] = struct{}{}
	d.mu.Unlock()
	return s, nil
}

// Stats implements transport.StatsReporter: for a stream, its message count
// and the consumer's pending and ack-pending counts; core subjects cannot tell.
func (d *Driver) Stats(ctx context.Context, channel string) (transport.ChannelStats, error) {
	_, js, err := d.conn()
	if err != nil {
		return transport.ChannelStats{}, err
	}
	if !d.isStream(channel) {
		return transport.ChannelStats{}, nil
	}
	stream, err := js.Stream(ctx, d.streamName(channel))
	if err != nil {
		return transport.ChannelStats{}, fmt.Errorf("nats: stream of %s: %w", channel, err)
	}
	info, err := stream.Info(ctx)
	if err != nil {
		return transport.ChannelStats{}, fmt.Errorf("nats: stream of %s: %w", channel, err)
	}
	stats := transport.ChannelStats{Depth: transport.Int(int(info.State.Msgs))}
	if consumer, err := stream.Consumer(ctx, StreamName(channel, "")); err == nil {
		if ci, err := consumer.Info(ctx); err == nil {
			// Active pull requests plus held deliveries are the live consumers of a work queue.
			stats.Consumers = transport.Int(ci.NumWaiting + ci.NumAckPending)
			stats.Lag = transport.Int(int(ci.NumPending))
		}
	}
	return stats, nil
}

// DeleteStreams removes the JetStream streams of channels (tests and operators).
func (d *Driver) DeleteStreams(ctx context.Context, channels ...string) error {
	_, js, err := d.conn()
	if err != nil {
		return err
	}
	if js == nil {
		return nil
	}
	for _, channel := range channels {
		if err := js.DeleteStream(ctx, d.streamName(channel)); err != nil && !errors.Is(err, jetstream.ErrStreamNotFound) {
			return fmt.Errorf("nats: delete stream of %s: %w", channel, err)
		}
	}
	return nil
}

// Close implements transport.Driver.
func (d *Driver) Close() error {
	d.mu.Lock()
	d.closed = true
	nc := d.nc
	d.nc, d.js = nil, nil
	subs := make([]*subscription, 0, len(d.subs))
	for s := range d.subs {
		subs = append(subs, s)
	}
	d.subs = map[*subscription]struct{}{}
	d.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, s := range subs {
		_ = s.Close(ctx)
	}
	if nc != nil {
		_ = nc.Drain()
		nc.Close()
	}
	return nil
}

// ---------------------------------------------------------------------------
// Subscriptions and deliveries
// ---------------------------------------------------------------------------

type subscription struct {
	d       *Driver
	channel string
	stop    func()
	cancel  context.CancelFunc
	done    chan struct{}
	closed  atomic.Bool

	mu   sync.Mutex
	held map[requeuer]struct{} // manual deliveries not yet settled
}

// requeuer is a held delivery that can go back for another consumer.
type requeuer interface {
	Nack(ctx context.Context, requeue bool) error
}

func (s *subscription) hold(r requeuer) {
	s.mu.Lock()
	if s.held != nil {
		s.held[r] = struct{}{}
	}
	s.mu.Unlock()
}

func (s *subscription) release(r requeuer) {
	s.mu.Lock()
	delete(s.held, r)
	s.mu.Unlock()
}

func (s *subscription) Channel() string { return s.channel }

// Close stops delivering and puts what this consumer still holds back for
// another one (as if it had died, only sooner): core events are republished,
// JetStream messages nak'd.
func (s *subscription) Close(ctx context.Context) error {
	if !s.closed.CompareAndSwap(false, true) {
		return nil
	}
	s.stop()
	s.mu.Lock()
	held := make([]requeuer, 0, len(s.held))
	for r := range s.held {
		held = append(held, r)
	}
	s.held = nil
	s.mu.Unlock()
	for _, r := range held {
		_ = r.Nack(ctx, true)
	}
	s.cancel()
	close(s.done)
	s.d.mu.Lock()
	delete(s.d.subs, s)
	s.d.mu.Unlock()
	return nil
}

// coreDelivery is a core NATS message: nothing to acknowledge; a requeue
// republishes the event with the next attempt and the requester's inbox.
type coreDelivery struct {
	nc      *natsgo.Conn
	msg     *natsgo.Msg
	slots   chan struct{}
	sub     *subscription
	settled atomic.Bool
}

func (c *coreDelivery) Attempt() int {
	if n, err := strconv.Atoi(c.msg.Header.Get(attemptHeader)); err == nil && n > 0 {
		return n
	}
	return 1
}

func (c *coreDelivery) settle() bool {
	if !c.settled.CompareAndSwap(false, true) {
		return false
	}
	c.sub.release(c)
	<-c.slots
	return true
}

func (c *coreDelivery) Ack(ctx context.Context) error {
	c.settle()
	return nil
}

func (c *coreDelivery) Nack(ctx context.Context, requeue bool) error {
	if !c.settle() || !requeue {
		return nil
	}
	again := natsgo.NewMsg(c.msg.Subject)
	again.Data = c.msg.Data
	for name, values := range c.msg.Header {
		again.Header[name] = append([]string(nil), values...)
	}
	again.Header.Set(attemptHeader, strconv.Itoa(c.Attempt()+1))
	if reply := replyOf(c.msg.Header, c.msg.Reply); reply != "" {
		again.Header.Set(replyHeader, reply)
	} else {
		again.Header.Del(replyHeader)
	}
	if err := c.nc.PublishMsg(again); err != nil {
		return fmt.Errorf("nats: requeue: %w", err)
	}
	return flush(ctx, c.nc)
}

func (c *coreDelivery) Reply(ctx context.Context, event transport.WireEvent) error {
	reply := replyOf(c.msg.Header, c.msg.Reply)
	if reply == "" {
		return errors.New("nats: the request carries no reply subject")
	}
	return c.nc.PublishMsg(newMsg(reply, event))
}

// jsDelivery is a JetStream message: explicit ack, nak = requeue, term = drop,
// NumDelivered = attempt; the reply goes to the inbox the requester sent along.
type jsDelivery struct {
	nc      *natsgo.Conn
	msg     jetstream.Msg
	slots   chan struct{}
	done    chan struct{}
	sub     *subscription
	settled atomic.Bool
}

func (j *jsDelivery) Attempt() int {
	if md, err := j.msg.Metadata(); err == nil && md.NumDelivered > 0 {
		return int(md.NumDelivered)
	}
	return 1
}

// keepAlive sends progress acks while the delivery is held, so a call longer
// than AckWait is not redelivered.
func (j *jsDelivery) keepAlive(ctx context.Context, every time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-j.done:
			return
		case <-ctx.Done():
			return
		case <-ticker.C:
			_ = j.msg.InProgress()
		}
	}
}

func (j *jsDelivery) settle(fn func() error) error {
	if !j.settled.CompareAndSwap(false, true) {
		return nil
	}
	j.sub.release(j)
	close(j.done)
	defer func() { <-j.slots }()
	return fn()
}

func (j *jsDelivery) Ack(ctx context.Context) error { return j.settle(j.msg.Ack) }

func (j *jsDelivery) Nack(ctx context.Context, requeue bool) error {
	if requeue {
		return j.settle(func() error { return j.msg.NakWithDelay(requeueDelay) })
	}
	return j.settle(j.msg.Term)
}

func (j *jsDelivery) Reply(ctx context.Context, event transport.WireEvent) error {
	inbox := j.msg.Headers().Get(replyHeader)
	if inbox == "" {
		return errors.New("nats: the request carries no reply inbox")
	}
	return j.nc.PublishMsg(newMsg(inbox, event))
}

var (
	_ transport.Driver        = (*Driver)(nil)
	_ transport.Requester     = (*Driver)(nil)
	_ transport.StatsReporter = (*Driver)(nil)
	_ transport.Replier       = (*coreDelivery)(nil)
	_ transport.Replier       = (*jsDelivery)(nil)
)
