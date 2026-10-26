// Package amqp is the RabbitMQ (AMQP 0-9-1) driver of sdks/go/transport
// (docs/transports.md "Brokers", docs/protocol.md §14.9), built on
// github.com/rabbitmq/amqp091-go.
//
//   - Shared channels (request, instance) are durable queues named after the
//     channel, published through the default exchange with `mandatory`, so an
//     unroutable event (no such queue) is reported at once. Request queues are
//     quorum queues by default (Config.QueueType); RabbitMQ 4 refuses transient
//     non-exclusive queues, so every named queue is durable.
//   - Broadcast channels (reply, registry, control) are durable fanout exchanges;
//     each consumer binds its own exclusive, server-named queue.
//   - Replies are native: direct reply-to (`amq.rabbitmq.reply-to`) on the
//     publishing channel, correlated by a driver-generated correlation id.
//   - CloudEvents attributes travel as `cloudEvents_` headers (binary mode),
//     the body as the message; `content-type` is the AMQP content-type property.
//   - Publisher confirms on every publish; per-message `expiration` for TTL;
//     consumer prefetch = ConsumeOptions.Prefetch; Attempt from quorum queues'
//     x-delivery-count (else `redelivered`).
//
// This package is its own Go module so sdks/go stays free of amqp091-go. Code
// use: amqp.New(amqp.Config{URL: "amqp://user:pass@127.0.0.1:55672/"}); env use:
// blank-import the package and set LANDFLOW_AMQP_URL (LANDFLOW_AMQP_USERNAME /
// _PASSWORD fill a URL without credentials; _TLS=true; _PREFIX; _QUEUE_TYPE).
package amqp

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	amqp091 "github.com/rabbitmq/amqp091-go"

	"github.com/landflow/landflow/sdks/go/transport"
)

// Kind is the transport kind this driver registers.
const Kind = "amqp"

// HeaderPrefix is the AMQP 0-9-1 protocol binding's prefix for CloudEvents attributes.
const HeaderPrefix = "cloudEvents_"

// directReplyTo is RabbitMQ's pseudo-queue for native replies.
const directReplyTo = "amq.rabbitmq.reply-to"

// Config configures a RabbitMQ driver.
type Config struct {
	transport.Config
	// URL is the AMQP URL ("amqp://user:pass@127.0.0.1:55672/vhost"; amqps:// for TLS).
	URL string
	// TLS, when set, is used for amqps:// URLs (default: the system roots).
	TLS *tls.Config
	// QueueType of durable request queues: "quorum" (default) or "classic".
	QueueType string
	// MaxMessageBytes the broker accepts (default 16 MiB, RabbitMQ 4's max_message_size).
	MaxMessageBytes int
	// QueueExpires deletes a request queue nobody used for this long (x-expires; default 24 h; negative keeps it forever).
	QueueExpires time.Duration
}

// Driver is one AMQP connection with a publishing channel (confirms, returns,
// direct reply-to) and one channel per subscription.
type Driver struct {
	cfg  Config
	caps transport.Capabilities

	mu      sync.Mutex
	conn    *amqp091.Connection
	pub     *amqp091.Channel
	stats   *amqp091.Channel
	closed  bool
	lost    chan struct{} // closed when the connection drops
	kinds   map[string]transport.ChannelDelivery
	waiters map[string]chan *amqp091.Delivery // request correlation id -> reply
	subs    map[*subscription]struct{}

	// Publishing is serialized so a publish sequence number maps to its message;
	// returns and confirms are read by one goroutine in dispatch order, so a
	// returned (unroutable) message is known before its confirm resolves.
	pubMu    sync.Mutex
	pending  map[uint64]*pendingPublish // publish seq -> waiter
	returned map[string]bool            // message ids the broker returned
}

type pendingPublish struct {
	messageID string
	done      chan publishResult
}

type publishResult struct {
	acked    bool
	returned bool
}

// New returns an unconnected driver; defaults are filled in.
func New(cfg Config) *Driver {
	if cfg.QueueType == "" {
		cfg.QueueType = "quorum"
	}
	if cfg.MaxMessageBytes <= 0 {
		cfg.MaxMessageBytes = 16 << 20
	}
	if cfg.QueueExpires == 0 {
		cfg.QueueExpires = 24 * time.Hour
	}
	if cfg.Prefix == "" {
		cfg.Prefix = transport.DefaultPrefix
	}
	return &Driver{
		cfg: cfg,
		caps: transport.Capabilities{
			Replies:         transport.RepliesNative,
			WorkSharing:     true,
			Buffering:       true,
			TTL:             true,
			Undeliverable:   transport.UndeliverableReported,
			Persistence:     transport.PersistenceDisk,
			MaxMessageBytes: cfg.MaxMessageBytes,
			Latency:         transport.LatencyMedium,
			Headers:         true,
			MaxHeaderBytes:  120 << 10, // the content header frame must fit one AMQP frame (frame_max 128 KiB)
			OrderingKeys:    false,
			Nack:            true,
			Attempts:        true,
		},
		kinds: map[string]transport.ChannelDelivery{}, returned: map[string]bool{}, pending: map[uint64]*pendingPublish{},
		waiters: map[string]chan *amqp091.Delivery{}, subs: map[*subscription]struct{}{},
	}
}

func init() {
	transport.RegisterDriver(Kind, func(connectionID, rawURL string, opts transport.ConnectionOptions) (transport.Driver, error) {
		cfg, err := ConfigFromURL(connectionID, rawURL, opts)
		if err != nil {
			return nil, err
		}
		return New(cfg), nil
	})
}

// ConfigFromURL builds a Config from an amqp:// or amqps:// URL and the
// connection options (username/password fill a URL without them; field
// queue_type = quorum|classic).
func ConfigFromURL(connectionID, rawURL string, opts transport.ConnectionOptions) (Config, error) {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || u.Host == "" {
		return Config{}, fmt.Errorf("amqp: malformed URL %q (want amqp://user:pass@host:port/vhost)", rawURL)
	}
	switch strings.ToLower(u.Scheme) {
	case "amqp":
		if opts.TLS {
			u.Scheme = "amqps"
		}
	case "amqps":
	default:
		return Config{}, fmt.Errorf("amqp: unsupported URL scheme %q (want amqp:// or amqps://)", u.Scheme)
	}
	if u.User == nil && opts.Username != "" {
		u.User = url.UserPassword(opts.Username, opts.Password)
	}
	cfg := Config{Config: transport.Config{ConnectionID: connectionID, Prefix: opts.Prefix}, URL: u.String()}
	switch qt := strings.ToLower(opts.Fields["queue_type"]); qt {
	case "":
	case "quorum", "classic":
		cfg.QueueType = qt
	default:
		return Config{}, fmt.Errorf("amqp: queue_type %q must be quorum or classic", qt)
	}
	return cfg, nil
}

// Kind implements transport.Driver.
func (d *Driver) Kind() string { return Kind }

// Capabilities implements transport.Driver.
func (d *Driver) Capabilities() transport.Capabilities { return d.caps }

// Config implements transport.Driver.
func (d *Driver) Config() transport.Config { return d.cfg.Config }

// AMQPConfig returns the full driver configuration.
func (d *Driver) AMQPConfig() Config { return d.cfg }

// Connect implements transport.Driver.
func (d *Driver) Connect(ctx context.Context) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return fmt.Errorf("amqp: driver closed: %w", transport.ErrNotConnected)
	}
	if d.conn != nil {
		return nil
	}
	dialCfg := amqp091.Config{Heartbeat: 10 * time.Second, Locale: "en_US", TLSClientConfig: d.cfg.TLS, Properties: amqp091.Table{"connection_name": "landflow"}}
	if deadline, ok := ctx.Deadline(); ok {
		dialCfg.Dial = amqp091.DefaultDial(time.Until(deadline))
	}
	conn, err := amqp091.DialConfig(d.cfg.URL, dialCfg)
	if err != nil {
		return fmt.Errorf("amqp: dial %s: %w", redact(d.cfg.URL), err)
	}
	pub, err := conn.Channel()
	if err != nil {
		conn.Close()
		return fmt.Errorf("amqp: open channel: %w", err)
	}
	if err := pub.Confirm(false); err != nil {
		conn.Close()
		return fmt.Errorf("amqp: publisher confirms: %w", err)
	}
	returns := pub.NotifyReturn(make(chan amqp091.Return))               // unbuffered: dispatch blocks until the return is recorded
	confirms := pub.NotifyPublish(make(chan amqp091.Confirmation, 1024)) // read by the same goroutine, after the return
	replies, err := pub.Consume(directReplyTo, "", true, true, false, false, nil)
	if err != nil {
		conn.Close()
		return fmt.Errorf("amqp: direct reply-to: %w", err)
	}
	d.conn, d.pub = conn, pub
	d.lost = make(chan struct{})
	lost := d.lost
	closeNotify := conn.NotifyClose(make(chan *amqp091.Error, 1))
	go func() {
		<-closeNotify
		d.mu.Lock()
		if d.conn == conn {
			d.conn, d.pub, d.stats = nil, nil, nil
			for id, w := range d.waiters {
				close(w)
				delete(d.waiters, id)
			}
		}
		d.mu.Unlock()
		close(lost)
	}()
	go d.settleLoop(returns, confirms)
	go func() {
		for del := range replies {
			del := del
			d.mu.Lock()
			w := d.waiters[del.CorrelationId]
			delete(d.waiters, del.CorrelationId)
			d.mu.Unlock()
			if w != nil {
				w <- &del
			}
		}
	}()
	return nil
}

func redact(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "<url>"
	}
	return u.Redacted()
}

func (d *Driver) publisher() (*amqp091.Channel, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.pub == nil {
		return nil, fmt.Errorf("amqp: %w", transport.ErrNotConnected)
	}
	return d.pub, nil
}

// channel opens a fresh channel for a subscription or an admin call.
func (d *Driver) channel() (*amqp091.Channel, error) {
	d.mu.Lock()
	conn := d.conn
	d.mu.Unlock()
	if conn == nil {
		return nil, fmt.Errorf("amqp: %w", transport.ErrNotConnected)
	}
	ch, err := conn.Channel()
	if err != nil {
		return nil, fmt.Errorf("amqp: open channel: %w", err)
	}
	return ch, nil
}

// Declare implements transport.Driver: durable queues for shared channels,
// durable fanout exchanges for broadcast ones. Idempotent.
func (d *Driver) Declare(ctx context.Context, channels []transport.ChannelSpec) error {
	ch, err := d.channel()
	if err != nil {
		return err
	}
	defer ch.Close()
	for _, spec := range channels {
		if spec.Delivery == transport.DeliveryBroadcast {
			if err := ch.ExchangeDeclare(spec.Name, "fanout", true, false, false, false, nil); err != nil {
				return fmt.Errorf("amqp: declare exchange %s: %w", spec.Name, err)
			}
		} else {
			args := amqp091.Table{}
			if spec.Durable && d.cfg.QueueType == "quorum" {
				args["x-queue-type"] = "quorum"
			}
			if spec.TTL > 0 {
				args["x-message-ttl"] = spec.TTL.Milliseconds()
			}
			if spec.Durable && d.cfg.QueueExpires > 0 {
				args["x-expires"] = d.cfg.QueueExpires.Milliseconds()
			}
			// An instance channel (not durable) is still a durable queue (RabbitMQ 4
			// refuses transient shared queues) but goes away with its last consumer.
			if _, err := ch.QueueDeclare(spec.Name, true, !spec.Durable, false, false, args); err != nil {
				return fmt.Errorf("amqp: declare queue %s: %w", spec.Name, err)
			}
		}
		d.mu.Lock()
		d.kinds[spec.Name] = spec.Delivery
		d.mu.Unlock()
	}
	return nil
}

// route returns the exchange and routing key for a channel.
func (d *Driver) route(channel string) (exchange, key string) {
	d.mu.Lock()
	kind := d.kinds[channel]
	d.mu.Unlock()
	if kind == transport.DeliveryBroadcast {
		return channel, ""
	}
	return "", channel
}

func newID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func publishing(event transport.WireEvent, ttl time.Duration) amqp091.Publishing {
	msg := amqp091.Publishing{Body: event.Body, DeliveryMode: amqp091.Persistent, Headers: amqp091.Table{}, Timestamp: time.Now()}
	for name, value := range transport.PrefixHeaders(event.Headers, HeaderPrefix) {
		if name == "content-type" {
			msg.ContentType = value
		} else {
			msg.Headers[name] = value
		}
	}
	if ttl > 0 {
		msg.Expiration = strconv.FormatInt(max(ttl.Milliseconds(), 1), 10)
	}
	return msg
}

// settleLoop reads basic.return and publisher confirms in the order the broker
// sent them (a return always precedes its message's confirm) and resolves the
// waiting publish. It ends when the channel closes, failing every waiter.
func (d *Driver) settleLoop(returns <-chan amqp091.Return, confirms <-chan amqp091.Confirmation) {
	for returns != nil || confirms != nil {
		select {
		case ret, ok := <-returns:
			if !ok {
				returns = nil
				continue
			}
			d.pubMu.Lock()
			d.returned[ret.MessageId] = true
			d.pubMu.Unlock()
		case conf, ok := <-confirms:
			if !ok {
				confirms = nil
				continue
			}
			d.pubMu.Lock()
			p := d.pending[conf.DeliveryTag]
			delete(d.pending, conf.DeliveryTag)
			var returned bool
			if p != nil {
				returned = d.returned[p.messageID]
				delete(d.returned, p.messageID)
			}
			d.pubMu.Unlock()
			if p != nil {
				p.done <- publishResult{acked: conf.Ack, returned: returned}
			}
		}
	}
	d.pubMu.Lock()
	for tag, p := range d.pending {
		close(p.done)
		delete(d.pending, tag)
	}
	d.pubMu.Unlock()
}

// publish sends with mandatory + confirms and reports a returned (unroutable) message.
func (d *Driver) publish(ctx context.Context, channel string, msg amqp091.Publishing) (transport.PublishOutcome, error) {
	pub, err := d.publisher()
	if err != nil {
		return "", err
	}
	if msg.MessageId == "" {
		msg.MessageId = newID()
	}
	exchange, key := d.route(channel)
	p := &pendingPublish{messageID: msg.MessageId, done: make(chan publishResult, 1)}
	d.pubMu.Lock()
	seq := pub.GetNextPublishSeqNo()
	d.pending[seq] = p
	err = pub.PublishWithContext(ctx, exchange, key, true, false, msg)
	if err != nil {
		delete(d.pending, seq)
	}
	d.pubMu.Unlock()
	if err != nil {
		if errors.Is(err, amqp091.ErrClosed) {
			return "", fmt.Errorf("amqp: %w", transport.ErrNotConnected)
		}
		return "", fmt.Errorf("amqp: publish to %s: %w", channel, err)
	}
	select {
	case res, ok := <-p.done:
		if !ok {
			return "", fmt.Errorf("amqp: publish to %s: the channel closed before the broker confirmed", channel)
		}
		if res.returned {
			return transport.Unroutable, nil
		}
		if !res.acked {
			return "", fmt.Errorf("amqp: publish to %s: the broker nacked the message", channel)
		}
		return transport.Accepted, nil
	case <-ctx.Done():
		d.pubMu.Lock()
		delete(d.pending, seq)
		d.pubMu.Unlock()
		return "", fmt.Errorf("amqp: publish to %s: %w", channel, ctx.Err())
	}
}

// inspect passively declares a queue: its counts, or ok false when it does not exist.
func (d *Driver) inspect(name string) (amqp091.Queue, bool, error) {
	d.mu.Lock()
	ch := d.stats
	d.mu.Unlock()
	if ch == nil || ch.IsClosed() {
		var err error
		if ch, err = d.channel(); err != nil {
			return amqp091.Queue{}, false, err
		}
		d.mu.Lock()
		d.stats = ch
		d.mu.Unlock()
	}
	q, err := ch.QueueDeclarePassive(name, true, false, false, false, nil)
	if err != nil {
		// A passive declare of a missing queue closes the channel (reopened on the next call).
		if isNotFound(err) {
			return amqp091.Queue{}, false, nil
		}
		return amqp091.Queue{}, false, fmt.Errorf("amqp: inspect %s: %w", name, err)
	}
	return q, true, nil
}

// hasConsumers reports whether a queue exists and has a consumer: "undeliverable
// is reported" means a publish to a queue nobody consumes is unroutable before
// anything is sent (as the TS driver does); a queue with busy consumers still buffers.
func (d *Driver) hasConsumers(queue string) (bool, error) {
	q, ok, err := d.inspect(queue)
	return ok && q.Consumers > 0, err
}

// Publish implements transport.Driver.
func (d *Driver) Publish(ctx context.Context, channel string, event transport.WireEvent, opts transport.PublishOptions) (transport.PublishOutcome, error) {
	if exchange, _ := d.route(channel); exchange == "" {
		if _, err := d.publisher(); err != nil {
			return "", err
		}
		if ok, err := d.hasConsumers(channel); err != nil {
			return "", err
		} else if !ok {
			return transport.Unroutable, nil
		}
	}
	return d.publish(ctx, channel, publishing(event, opts.TTL))
}

// Request implements transport.Requester with direct reply-to.
func (d *Driver) Request(ctx context.Context, channel string, event transport.WireEvent, opts transport.RequestOptions) (transport.RequestResult, error) {
	if _, err := d.publisher(); err != nil {
		return transport.RequestResult{}, err
	}
	if exchange, _ := d.route(channel); exchange == "" {
		if ok, err := d.hasConsumers(channel); err != nil {
			return transport.RequestResult{}, err
		} else if !ok {
			return transport.RequestResult{Outcome: transport.RequestUnroutable}, nil
		}
	}
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	msg := publishing(event, timeout)
	msg.MessageId = newID()
	msg.CorrelationId = msg.MessageId
	msg.ReplyTo = directReplyTo
	wait := make(chan *amqp091.Delivery, 1)
	d.mu.Lock()
	d.waiters[msg.CorrelationId] = wait
	lost := d.lost
	d.mu.Unlock()
	forget := func() {
		d.mu.Lock()
		delete(d.waiters, msg.CorrelationId)
		d.mu.Unlock()
	}
	outcome, err := d.publish(ctx, channel, msg)
	if err != nil {
		forget()
		return transport.RequestResult{}, err
	}
	if outcome == transport.Unroutable {
		forget()
		return transport.RequestResult{Outcome: transport.RequestUnroutable}, nil
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case del, ok := <-wait:
		if !ok || del == nil {
			return transport.RequestResult{}, errors.New("amqp: connection lost while waiting for the reply")
		}
		return transport.RequestResult{Outcome: transport.RequestReplied, Event: wireEvent(del)}, nil
	case <-lost:
		forget()
		return transport.RequestResult{}, errors.New("amqp: connection lost while waiting for the reply")
	case <-timer.C:
		forget()
		return transport.RequestResult{Outcome: transport.RequestTimeout}, nil
	case <-ctx.Done():
		forget()
		return transport.RequestResult{}, ctx.Err()
	}
}

func wireEvent(del *amqp091.Delivery) transport.WireEvent {
	headers := make(map[string]string, len(del.Headers)+1)
	for name, value := range del.Headers {
		if s, ok := value.(string); ok {
			headers[name] = s
		}
	}
	if del.ContentType != "" {
		headers["content-type"] = del.ContentType
	}
	return transport.WireEvent{Headers: transport.UnprefixHeaders(headers, HeaderPrefix), Body: del.Body}
}

// Consume implements transport.Driver.
func (d *Driver) Consume(ctx context.Context, channel string, opts transport.ConsumeOptions, handler transport.Handler) (transport.Subscription, error) {
	ch, err := d.channel()
	if err != nil {
		return nil, err
	}
	prefetch := max(opts.Prefetch, 1)
	queue := channel
	exchange, _ := d.route(channel)
	if exchange != "" || opts.Group == "" {
		// Broadcast: an exclusive, server-named queue bound to the channel's fanout exchange.
		q, err := ch.QueueDeclare("", false, true, true, false, nil)
		if err != nil {
			ch.Close()
			return nil, fmt.Errorf("amqp: declare broadcast queue for %s: %w", channel, err)
		}
		if exchange == "" {
			exchange = channel
			if err := ch.ExchangeDeclare(exchange, "fanout", true, false, false, false, nil); err != nil {
				ch.Close()
				return nil, fmt.Errorf("amqp: declare exchange %s: %w", channel, err)
			}
		}
		if err := ch.QueueBind(q.Name, "", exchange, false, nil); err != nil {
			ch.Close()
			return nil, fmt.Errorf("amqp: bind to %s: %w", channel, err)
		}
		queue = q.Name
	}
	autoAck := opts.AckMode == transport.AckAuto || opts.Group == ""
	if err := ch.Qos(prefetch, 0, false); err != nil {
		ch.Close()
		return nil, fmt.Errorf("amqp: qos: %w", err)
	}
	tag := "landflow-" + newID()
	deliveries, err := ch.Consume(queue, tag, autoAck, false, false, false, nil)
	if err != nil {
		ch.Close()
		return nil, fmt.Errorf("amqp: consume %s: %w", channel, err)
	}
	s := &subscription{d: d, channel: channel, ch: ch, tag: tag, done: make(chan struct{})}
	d.mu.Lock()
	d.subs[s] = struct{}{}
	d.mu.Unlock()
	runCtx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	slots := make(chan struct{}, prefetch)
	go func() {
		defer close(s.done)
		for del := range deliveries {
			del := del
			slots <- struct{}{}
			go func() {
				defer func() { <-slots }()
				handler(runCtx, wireEvent(&del), &delivery{s: s, del: &del, autoAck: autoAck})
			}()
		}
	}()
	return s, nil
}

// Stats implements transport.StatsReporter with a passive queue declare.
func (d *Driver) Stats(ctx context.Context, channel string) (transport.ChannelStats, error) {
	if exchange, _ := d.route(channel); exchange != "" {
		return transport.ChannelStats{}, nil // a fanout exchange has no depth
	}
	q, ok, err := d.inspect(channel)
	if err != nil {
		return transport.ChannelStats{}, err
	}
	if !ok {
		return transport.ChannelStats{Depth: transport.Int(0), Consumers: transport.Int(0)}, nil
	}
	return transport.ChannelStats{Depth: transport.Int(q.Messages), Consumers: transport.Int(q.Consumers)}, nil
}

// DeleteChannels removes the queues and exchanges of channels (tests and operators).
func (d *Driver) DeleteChannels(ctx context.Context, channels ...string) error {
	for _, name := range channels {
		ch, err := d.channel()
		if err != nil {
			return err
		}
		if exchange, _ := d.route(name); exchange != "" {
			err = ch.ExchangeDelete(name, false, false)
		} else {
			_, err = ch.QueueDelete(name, false, false, false)
		}
		ch.Close()
		if err != nil && !isNotFound(err) {
			return fmt.Errorf("amqp: delete %s: %w", name, err)
		}
	}
	return nil
}

func isNotFound(err error) bool {
	var e *amqp091.Error
	return errors.As(err, &e) && e.Code == amqp091.NotFound
}

// Close implements transport.Driver.
func (d *Driver) Close() error {
	d.mu.Lock()
	d.closed = true
	conn := d.conn
	d.conn, d.pub, d.stats = nil, nil, nil
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
	if conn != nil {
		return conn.Close()
	}
	return nil
}

// ---------------------------------------------------------------------------
// Subscriptions and deliveries
// ---------------------------------------------------------------------------

type subscription struct {
	d       *Driver
	channel string
	ch      *amqp091.Channel
	tag     string
	cancel  context.CancelFunc
	done    chan struct{}
	closed  atomic.Bool
}

func (s *subscription) Channel() string { return s.channel }

// Close cancels the consumer and closes its channel: unacknowledged deliveries
// go back to the queue.
func (s *subscription) Close(ctx context.Context) error {
	if !s.closed.CompareAndSwap(false, true) {
		return nil
	}
	_ = s.ch.Cancel(s.tag, false)
	err := s.ch.Close()
	s.cancel()
	select {
	case <-s.done:
	case <-ctx.Done():
	}
	s.d.mu.Lock()
	delete(s.d.subs, s)
	s.d.mu.Unlock()
	if err != nil && !errors.Is(err, amqp091.ErrClosed) {
		return err
	}
	return nil
}

type delivery struct {
	s       *subscription
	del     *amqp091.Delivery
	autoAck bool
	settled atomic.Bool
}

// Attempt: quorum queues count deliveries in x-delivery-count (0 on the first);
// classic queues only flag `redelivered`.
func (d *delivery) Attempt() int {
	if n, ok := d.del.Headers["x-delivery-count"]; ok {
		switch v := n.(type) {
		case int64:
			return int(v) + 1
		case int32:
			return int(v) + 1
		case int:
			return v + 1
		}
	}
	if d.del.Redelivered {
		return 2
	}
	return 1
}

func (d *delivery) Ack(ctx context.Context) error {
	if d.autoAck || !d.settled.CompareAndSwap(false, true) {
		return nil
	}
	if err := d.del.Ack(false); err != nil && !errors.Is(err, amqp091.ErrClosed) {
		return fmt.Errorf("amqp: ack: %w", err)
	}
	return nil
}

func (d *delivery) Nack(ctx context.Context, requeue bool) error {
	if d.autoAck || !d.settled.CompareAndSwap(false, true) {
		return nil
	}
	if err := d.del.Nack(false, requeue); err != nil && !errors.Is(err, amqp091.ErrClosed) {
		return fmt.Errorf("amqp: nack: %w", err)
	}
	return nil
}

// Reply implements transport.Replier: the response goes to the request's
// reply-to address with its correlation id.
func (d *delivery) Reply(ctx context.Context, event transport.WireEvent) error {
	if d.del.ReplyTo == "" {
		return errors.New("amqp: the request carries no reply-to address")
	}
	pub, err := d.s.d.publisher()
	if err != nil {
		return err
	}
	msg := publishing(event, 0)
	msg.CorrelationId = d.del.CorrelationId
	msg.DeliveryMode = amqp091.Transient
	msg.MessageId = newID()
	drv := d.s.d
	p := &pendingPublish{messageID: msg.MessageId, done: make(chan publishResult, 1)}
	drv.pubMu.Lock()
	seq := pub.GetNextPublishSeqNo()
	drv.pending[seq] = p
	// Not mandatory: a requester that already left (its reply-to is gone) is not an error.
	err = pub.PublishWithContext(ctx, "", d.del.ReplyTo, false, false, msg)
	if err != nil {
		delete(drv.pending, seq)
	}
	drv.pubMu.Unlock()
	if err != nil {
		return fmt.Errorf("amqp: reply: %w", err)
	}
	select {
	case res, ok := <-p.done:
		if !ok || !res.acked {
			return errors.New("amqp: reply: the broker did not confirm the message")
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

var (
	_ transport.Driver        = (*Driver)(nil)
	_ transport.Requester     = (*Driver)(nil)
	_ transport.StatsReporter = (*Driver)(nil)
	_ transport.Replier       = (*delivery)(nil)
)
