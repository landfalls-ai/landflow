// Package pulsar is the Apache Pulsar driver of sdks/go/transport
// (docs/transports.md "Brokers", docs/protocol.md §14.9), built on
// github.com/apache/pulsar-client-go. It is wire-compatible with the TypeScript
// driver (@landflow/transports/pulsar).
//
//   - A persistent topic per channel, persistent://<tenant>/<namespace>/<channel>
//     (default public/default); CloudEvents attributes travel as message
//     properties under `ce_` (binary mode), the ordering key as the partition key.
//   - Shared channels (request, instance): a durable Shared subscription named
//     after the group (the core uses the channel name), created on Declare so
//     the topic buffers; each consumer pulls with ReceiverQueueSize = prefetch
//     and hands the core at most prefetch unacknowledged deliveries. Ack
//     acknowledges, Nack(requeue) negative-acknowledges (redelivered after
//     NackRedeliveryDelay with RedeliveryCount+1 as the attempt), Nack(drop)
//     acknowledges. A closing subscription negative-acknowledges what it holds
//     before closing, so a survivor gets a truthful attempt; a hard kill's
//     redelivery is attempt 1 (Pulsar does not count it).
//   - Broadcast channels (reply, registry, control): a non-durable reader per
//     consumer from the latest message.
//   - Replies: a reply topic per host (RepliesChannel). TTL is a namespace
//     policy in Pulsar, not claimed. "Nobody took it" is inferred through the
//     admin API (Config.AdminURL): Stats reports the subscription's consumers
//     and backlog; without it Stats returns nothing and the core waits for the
//     deadline. Close deletes the per-process reply and instance topics when
//     AdminURL is set.
//
// This package is its own Go module so sdks/go stays free of the Pulsar client.
// Code use: pulsar.New(pulsar.Config{ServiceURL: "pulsar://127.0.0.1:56650"});
// env use: blank-import the package and set LANDFLOW_PULSAR_URL (plus optional
// LANDFLOW_PULSAR_PASSWORD for a JWT, _TLS=true, _PREFIX, _ADMINURL, _TENANT,
// _NAMESPACE).
package pulsar

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	pulsarclient "github.com/apache/pulsar-client-go/pulsar"
	pulsarlog "github.com/apache/pulsar-client-go/pulsar/log"

	"github.com/landflow/landflow/sdks/go/transport"
)

// Kind is the transport kind this driver registers.
const Kind = "pulsar"

// HeaderPrefix is the prefix of CloudEvents attributes on message properties (as the TS driver writes them).
const HeaderPrefix = "ce_"

// DefaultMaxMessageBytes is Pulsar's default broker maxMessageSize (5 MB).
const DefaultMaxMessageBytes = 5 * 1024 * 1024

const (
	defaultTenant     = "public"
	defaultNamespace  = "default"
	defaultNackDelay  = 100 * time.Millisecond
	defaultConnectTO  = 10 * time.Second
	defaultOperationT = 30 * time.Second
	receivePoll       = 500 * time.Millisecond
	adminTimeout      = 10 * time.Second
)

// Config configures a Pulsar driver.
type Config struct {
	transport.Config
	// ServiceURL is pulsar://host:6650 or pulsar+ssl://host:6651.
	ServiceURL string
	// AdminURL is the admin REST API (http://host:8080); it enables Stats and topic deletion on Close.
	AdminURL string
	// Tenant and Namespace of the topics (default public / default); the namespace must exist.
	Tenant, Namespace string
	// Token is a JWT for token authentication (also sent to the admin API).
	Token string
	// TLS settings for pulsar+ssl://.
	TLSTrustCertsFilePath      string
	TLSAllowInsecureConnection bool
	// MaxMessageBytes the broker accepts (default 5 MB).
	MaxMessageBytes int
	// NackRedeliveryDelay before the broker redelivers a negatively acknowledged event (default 100 ms).
	NackRedeliveryDelay time.Duration
	// ConnectTimeout bounds Connect (default 10 s); OperationTimeout bounds producer/consumer creation and sends (default 30 s).
	ConnectTimeout, OperationTimeout time.Duration
}

// Driver is a Pulsar connection: one client, a producer per topic and a consumer or reader per subscription.
type Driver struct {
	cfg  Config
	caps transport.Capabilities

	mu        sync.Mutex
	client    pulsarclient.Client
	producers map[string]pulsarclient.Producer
	declared  map[string]transport.ChannelSpec
	subs      map[*subscription]struct{}
	closed    bool
}

// New returns an unconnected driver; defaults are filled in.
func New(cfg Config) *Driver {
	if cfg.Tenant == "" {
		cfg.Tenant = defaultTenant
	}
	if cfg.Namespace == "" {
		cfg.Namespace = defaultNamespace
	}
	if cfg.MaxMessageBytes <= 0 {
		cfg.MaxMessageBytes = DefaultMaxMessageBytes
	}
	if cfg.NackRedeliveryDelay <= 0 {
		cfg.NackRedeliveryDelay = defaultNackDelay
	}
	if cfg.ConnectTimeout <= 0 {
		cfg.ConnectTimeout = defaultConnectTO
	}
	if cfg.OperationTimeout <= 0 {
		cfg.OperationTimeout = defaultOperationT
	}
	if cfg.Prefix == "" {
		cfg.Prefix = transport.DefaultPrefix
	}
	return &Driver{
		cfg: cfg,
		caps: transport.Capabilities{
			Replies:         transport.RepliesChannel,
			WorkSharing:     true,
			Buffering:       true,
			TTL:             false,
			Undeliverable:   transport.UndeliverableInferred,
			Persistence:     transport.PersistenceDisk,
			MaxMessageBytes: cfg.MaxMessageBytes,
			Latency:         transport.LatencyMedium,
			Headers:         true,
			OrderingKeys:    false,
			Nack:            true,
			Attempts:        true,
		},
		producers: map[string]pulsarclient.Producer{},
		declared:  map[string]transport.ChannelSpec{},
		subs:      map[*subscription]struct{}{},
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

var (
	serviceURLRE = regexp.MustCompile(`^(?i)(pulsar|pulsar\+ssl|pulsars)://([^/?#@]+)/?$`)
	segmentRE    = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)
)

// ConfigFromURL builds a Config from pulsar://host:6650 or pulsar+ssl://host:6651
// and the connection options: the password is a JWT; fields adminurl, tenant,
// namespace (and maxmessagebytes).
func ConfigFromURL(connectionID, rawURL string, opts transport.ConnectionOptions) (Config, error) {
	m := serviceURLRE.FindStringSubmatch(strings.TrimSpace(rawURL))
	if m == nil {
		return Config{}, fmt.Errorf("pulsar: %q is not a Pulsar service URL (want pulsar://host:6650 or pulsar+ssl://host:6651; the token goes in the password)", rawURL)
	}
	tls := opts.TLS || !strings.EqualFold(m[1], "pulsar")
	u, err := url.Parse("tcp://" + m[2])
	if err != nil || u.Hostname() == "" {
		return Config{}, fmt.Errorf("pulsar: %q is not a host:port", m[2])
	}
	port := u.Port()
	if port == "" {
		port = "6650"
		if tls {
			port = "6651"
		}
	}
	if n, err := strconv.Atoi(port); err != nil || n < 1 || n > 65535 {
		return Config{}, fmt.Errorf("pulsar: %q has an invalid port", m[2])
	}
	scheme := "pulsar"
	if tls {
		scheme = "pulsar+ssl"
	}
	host := u.Hostname()
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	cfg := Config{
		Config:     transport.Config{ConnectionID: connectionID, Prefix: opts.Prefix},
		ServiceURL: scheme + "://" + host + ":" + port,
		Token:      opts.Password,
		Tenant:     strings.TrimSpace(opts.Fields["tenant"]),
		Namespace:  strings.TrimSpace(opts.Fields["namespace"]),
	}
	for what, v := range map[string]string{"tenant": cfg.Tenant, "namespace": cfg.Namespace} {
		if v != "" && !segmentRE.MatchString(v) {
			return Config{}, fmt.Errorf("pulsar: %s %q must be 1-64 characters of letters, digits, \".\", \"_\" or \"-\"", what, v)
		}
	}
	if admin := strings.TrimRight(strings.TrimSpace(opts.Fields["adminurl"]), "/"); admin != "" {
		au, err := url.Parse(admin)
		if err != nil || (au.Scheme != "http" && au.Scheme != "https") || au.Host == "" || au.Path != "" {
			return Config{}, fmt.Errorf("pulsar: admin URL %q must be http(s)://host:port", admin)
		}
		cfg.AdminURL = admin
	}
	if raw := opts.Fields["maxmessagebytes"]; raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			return Config{}, fmt.Errorf("pulsar: maxmessagebytes %q must be a positive integer", raw)
		}
		cfg.MaxMessageBytes = n
	}
	return cfg, nil
}

// TopicName is the full topic of a channel.
func (d *Driver) TopicName(channel string) string {
	return "persistent://" + d.cfg.Tenant + "/" + d.cfg.Namespace + "/" + channel
}

func (d *Driver) adminPath(channel string) string {
	return "persistent/" + url.PathEscape(d.cfg.Tenant) + "/" + url.PathEscape(d.cfg.Namespace) + "/" + url.PathEscape(channel)
}

// Kind implements transport.Driver.
func (d *Driver) Kind() string { return Kind }

// Capabilities implements transport.Driver.
func (d *Driver) Capabilities() transport.Capabilities { return d.caps }

// Config implements transport.Driver.
func (d *Driver) Config() transport.Config { return d.cfg.Config }

// PulsarConfig returns the full driver configuration.
func (d *Driver) PulsarConfig() Config { return d.cfg }

// Connect implements transport.Driver: it creates the client and opens (and
// closes) a producer on a non-persistent probe topic, so an unreachable broker
// fails here before anything is sent.
func (d *Driver) Connect(ctx context.Context) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return fmt.Errorf("pulsar: driver closed: %w", transport.ErrNotConnected)
	}
	if d.client != nil {
		return nil
	}
	opts := pulsarclient.ClientOptions{
		URL:                        d.cfg.ServiceURL,
		ConnectionTimeout:          d.cfg.ConnectTimeout,
		OperationTimeout:           d.cfg.OperationTimeout,
		TLSTrustCertsFilePath:      d.cfg.TLSTrustCertsFilePath,
		TLSAllowInsecureConnection: d.cfg.TLSAllowInsecureConnection,
		Logger:                     pulsarlog.DefaultNopLogger(),
	}
	if d.cfg.Token != "" {
		opts.Authentication = pulsarclient.NewAuthenticationToken(d.cfg.Token)
	}
	client, err := pulsarclient.NewClient(opts)
	if err != nil {
		return fmt.Errorf("pulsar: %w", err)
	}
	raw := make([]byte, 4)
	_, _ = rand.Read(raw)
	probe := "non-persistent://" + d.cfg.Tenant + "/" + d.cfg.Namespace + "/" + d.cfg.Prefix + "-probe-" + hex.EncodeToString(raw)
	type result struct {
		p   pulsarclient.Producer
		err error
	}
	done := make(chan result, 1)
	go func() {
		p, err := client.CreateProducer(pulsarclient.ProducerOptions{Topic: probe, SendTimeout: d.cfg.ConnectTimeout})
		done <- result{p, err}
	}()
	select {
	case r := <-done:
		if r.err != nil {
			client.Close()
			return fmt.Errorf("pulsar: cannot connect to %s: %w", d.cfg.ServiceURL, r.err)
		}
		r.p.Close()
	case <-time.After(d.cfg.ConnectTimeout):
		go func() {
			if r := <-done; r.err == nil {
				r.p.Close()
			}
			client.Close()
		}()
		return fmt.Errorf("pulsar: cannot connect to %s: timed out after %s", d.cfg.ServiceURL, d.cfg.ConnectTimeout)
	case <-ctx.Done():
		go func() {
			if r := <-done; r.err == nil {
				r.p.Close()
			}
			client.Close()
		}()
		return fmt.Errorf("pulsar: cannot connect to %s: %w", d.cfg.ServiceURL, ctx.Err())
	}
	d.client = client
	return nil
}

func (d *Driver) connected() (pulsarclient.Client, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.client == nil {
		return nil, fmt.Errorf("pulsar: %w", transport.ErrNotConnected)
	}
	return d.client, nil
}

// Declare implements transport.Driver: shared channels get their durable
// subscription (named after the channel), broadcast channels their topic.
func (d *Driver) Declare(ctx context.Context, channels []transport.ChannelSpec) error {
	client, err := d.connected()
	if err != nil {
		return err
	}
	for _, ch := range channels {
		d.mu.Lock()
		_, done := d.declared[ch.Name]
		d.mu.Unlock()
		if done {
			continue
		}
		if ch.Delivery == transport.DeliveryShared {
			c, err := client.Subscribe(pulsarclient.ConsumerOptions{Topic: d.TopicName(ch.Name), SubscriptionName: ch.Name, Type: pulsarclient.Shared, SubscriptionInitialPosition: pulsarclient.SubscriptionPositionEarliest, ReceiverQueueSize: 1})
			if err != nil {
				return fmt.Errorf("pulsar: declare %s: %w", ch.Name, err)
			}
			c.Close()
		} else if _, err := d.producerFor(ch.Name); err != nil {
			return fmt.Errorf("pulsar: declare %s: %w", ch.Name, err)
		}
		d.mu.Lock()
		d.declared[ch.Name] = ch
		d.mu.Unlock()
	}
	return nil
}

func (d *Driver) producerFor(channel string) (pulsarclient.Producer, error) {
	d.mu.Lock()
	client := d.client
	p, ok := d.producers[channel]
	d.mu.Unlock()
	if client == nil {
		return nil, fmt.Errorf("pulsar: %w", transport.ErrNotConnected)
	}
	if ok {
		return p, nil
	}
	p, err := client.CreateProducer(pulsarclient.ProducerOptions{Topic: d.TopicName(channel), SendTimeout: d.cfg.OperationTimeout, DisableBatching: true})
	if err != nil {
		return nil, err
	}
	d.mu.Lock()
	if existing, ok := d.producers[channel]; ok {
		d.mu.Unlock()
		p.Close()
		return existing, nil
	}
	d.producers[channel] = p
	d.mu.Unlock()
	return p, nil
}

// Publish implements transport.Driver: one message, sent synchronously.
func (d *Driver) Publish(ctx context.Context, channel string, event transport.WireEvent, opts transport.PublishOptions) (transport.PublishOutcome, error) {
	if _, err := d.connected(); err != nil {
		return "", err
	}
	p, err := d.producerFor(channel)
	if err != nil {
		return "", fmt.Errorf("pulsar: producer for %s: %w", channel, err)
	}
	msg := &pulsarclient.ProducerMessage{Payload: event.Body, Properties: transport.PrefixHeaders(event.Headers, HeaderPrefix), Key: opts.OrderingKey}
	if _, err := p.Send(ctx, msg); err != nil {
		return "", fmt.Errorf("pulsar: send to %s: %w", channel, err)
	}
	return transport.Accepted, nil
}

// Consume implements transport.Driver.
func (d *Driver) Consume(ctx context.Context, channel string, opts transport.ConsumeOptions, handler transport.Handler) (transport.Subscription, error) {
	client, err := d.connected()
	if err != nil {
		return nil, err
	}
	prefetch := max(opts.Prefetch, 1)
	runCtx, cancel := context.WithCancel(context.Background())
	s := &subscription{d: d, channel: channel, cancel: cancel, done: make(chan struct{}), handler: handler, manual: opts.AckMode != transport.AckAuto && opts.Group != "", slots: make(chan struct{}, prefetch), held: map[*delivery]struct{}{}}
	if opts.Group == "" {
		reader, err := client.CreateReader(pulsarclient.ReaderOptions{Topic: d.TopicName(channel), StartMessageID: pulsarclient.LatestMessageID(), ReceiverQueueSize: prefetch})
		if err != nil {
			cancel()
			return nil, fmt.Errorf("pulsar: reader on %s: %w", channel, err)
		}
		s.reader = reader
	} else {
		consumer, err := client.Subscribe(pulsarclient.ConsumerOptions{
			Topic: d.TopicName(channel), SubscriptionName: opts.Group, Type: pulsarclient.Shared,
			SubscriptionInitialPosition: pulsarclient.SubscriptionPositionEarliest, ReceiverQueueSize: prefetch, NackRedeliveryDelay: d.cfg.NackRedeliveryDelay,
		})
		if err != nil {
			cancel()
			return nil, fmt.Errorf("pulsar: subscribe %s (group %s): %w", channel, opts.Group, err)
		}
		s.consumer = consumer
	}
	d.mu.Lock()
	d.subs[s] = struct{}{}
	d.mu.Unlock()
	go s.run(runCtx)
	return s, nil
}

// Stats implements transport.StatsReporter through the admin API: the
// channel's subscription consumers and backlog. Nothing without AdminURL.
func (d *Driver) Stats(ctx context.Context, channel string) (transport.ChannelStats, error) {
	if _, err := d.connected(); err != nil {
		return transport.ChannelStats{}, err
	}
	if d.cfg.AdminURL == "" {
		return transport.ChannelStats{}, nil
	}
	status, raw, err := d.admin(ctx, http.MethodGet, d.adminPath(channel)+"/stats")
	if err != nil {
		return transport.ChannelStats{}, err
	}
	if status == http.StatusNotFound {
		return transport.ChannelStats{Consumers: transport.Int(0), Depth: transport.Int(0)}, nil
	}
	if status/100 != 2 {
		return transport.ChannelStats{}, fmt.Errorf("pulsar: admin API answered %d for %s", status, channel)
	}
	var body struct {
		Subscriptions map[string]struct {
			Consumers  []json.RawMessage `json:"consumers"`
			MsgBacklog int               `json:"msgBacklog"`
		} `json:"subscriptions"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return transport.ChannelStats{}, fmt.Errorf("pulsar: admin API: %w", err)
	}
	sub := body.Subscriptions[channel]
	return transport.ChannelStats{Consumers: transport.Int(len(sub.Consumers)), Depth: transport.Int(sub.MsgBacklog)}, nil
}

func (d *Driver) admin(ctx context.Context, method, path string) (int, []byte, error) {
	ctx, cancel := context.WithTimeout(ctx, adminTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(d.cfg.AdminURL, "/")+"/admin/v2/"+path, nil)
	if err != nil {
		return 0, nil, err
	}
	if d.cfg.Token != "" {
		req.Header.Set("Authorization", "Bearer "+d.cfg.Token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("pulsar: admin API: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, nil, fmt.Errorf("pulsar: admin API: %w", err)
	}
	return resp.StatusCode, raw, nil
}

// DeleteTopics force-deletes channels' topics through the admin API (tests and operators; the core never calls it).
func (d *Driver) DeleteTopics(ctx context.Context, channels ...string) error {
	if d.cfg.AdminURL == "" {
		return errors.New("pulsar: no AdminURL configured")
	}
	for _, ch := range channels {
		if _, _, err := d.admin(ctx, http.MethodDelete, d.adminPath(ch)+"?force=true"); err != nil {
			return err
		}
	}
	return nil
}

// Close implements transport.Driver.
func (d *Driver) Close() error {
	d.mu.Lock()
	d.closed = true
	client := d.client
	d.client = nil
	subs := make([]*subscription, 0, len(d.subs))
	for s := range d.subs {
		subs = append(subs, s)
	}
	d.subs = map[*subscription]struct{}{}
	producers := d.producers
	d.producers = map[string]pulsarclient.Producer{}
	var ephemeral []string
	for _, spec := range d.declared {
		if spec.Role == transport.RoleReply || spec.Role == transport.RoleInstance {
			ephemeral = append(ephemeral, spec.Name)
		}
	}
	d.declared = map[string]transport.ChannelSpec{}
	d.mu.Unlock()
	if client == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	for _, s := range subs {
		_ = s.Close(ctx)
	}
	for _, p := range producers {
		p.Close()
	}
	if d.cfg.AdminURL != "" && len(ephemeral) > 0 {
		_ = d.DeleteTopics(ctx, ephemeral...)
	}
	client.Close()
	return nil
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

type subscription struct {
	d        *Driver
	channel  string
	consumer pulsarclient.Consumer
	reader   pulsarclient.Reader
	cancel   context.CancelFunc
	done     chan struct{}
	handler  transport.Handler
	manual   bool
	slots    chan struct{}
	closed   atomic.Bool

	heldMu sync.Mutex
	held   map[*delivery]struct{}
}

func (s *subscription) Channel() string { return s.channel }

func (s *subscription) run(ctx context.Context) {
	defer close(s.done)
	if s.reader != nil {
		for ctx.Err() == nil {
			msg, err := s.reader.Next(ctx)
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				time.Sleep(50 * time.Millisecond)
				continue
			}
			s.handler(ctx, toWire(msg), &delivery{s: s, msg: msg, attempt: 1, settled: atomic.Bool{}})
		}
		return
	}
	for ctx.Err() == nil {
		if s.manual {
			select {
			case s.slots <- struct{}{}:
			case <-ctx.Done():
				return
			}
		}
		pollCtx, cancel := context.WithTimeout(ctx, receivePoll)
		msg, err := s.consumer.Receive(pollCtx)
		cancel()
		if err != nil {
			if s.manual {
				<-s.slots
			}
			if ctx.Err() != nil {
				return
			}
			if !errors.Is(err, context.DeadlineExceeded) {
				time.Sleep(50 * time.Millisecond)
			}
			continue
		}
		del := &delivery{s: s, msg: msg, attempt: int(msg.RedeliveryCount()) + 1}
		if !s.manual {
			_ = s.consumer.Ack(msg)
			del.settled.Store(true)
			s.handler(ctx, toWire(msg), del)
			continue
		}
		s.heldMu.Lock()
		if s.held != nil {
			s.held[del] = struct{}{}
		}
		s.heldMu.Unlock()
		go s.handler(ctx, toWire(msg), del)
	}
}

// Close stops delivering. Deliveries still held are negative-acknowledged
// first, before the subscription context is cancelled (so the core's own
// settlement of a call it aborts on close cannot beat the hand-off), and the
// client gets the redelivery delay to send the request before the consumer
// goes away: a survivor gets them with the next attempt.
func (s *subscription) Close(ctx context.Context) error {
	if !s.closed.CompareAndSwap(false, true) {
		return nil
	}
	if s.reader != nil {
		s.cancel()
		select {
		case <-s.done:
		case <-ctx.Done():
		}
		s.d.mu.Lock()
		delete(s.d.subs, s)
		s.d.mu.Unlock()
		s.reader.Close()
		return nil
	}
	nacked := s.nackHeld()
	s.cancel()
	select {
	case <-s.done:
	case <-ctx.Done():
	}
	nacked += s.nackHeld()
	s.d.mu.Lock()
	delete(s.d.subs, s)
	s.d.mu.Unlock()
	if nacked > 0 {
		time.Sleep(s.d.cfg.NackRedeliveryDelay + 50*time.Millisecond)
	}
	s.consumer.Close()
	return nil
}

func (s *subscription) nackHeld() int {
	s.heldMu.Lock()
	held := make([]*delivery, 0, len(s.held))
	for del := range s.held {
		held = append(held, del)
		delete(s.held, del)
	}
	s.heldMu.Unlock()
	n := 0
	for _, del := range held {
		if del.settled.CompareAndSwap(false, true) {
			<-s.slots
			s.consumer.Nack(del.msg)
			n++
		}
	}
	return n
}

func toWire(msg pulsarclient.Message) transport.WireEvent {
	return transport.WireEvent{Headers: transport.UnprefixHeaders(msg.Properties(), HeaderPrefix), Body: msg.Payload()}
}

type delivery struct {
	s       *subscription
	msg     pulsarclient.Message
	attempt int
	settled atomic.Bool
}

func (d *delivery) Attempt() int { return d.attempt }

func (d *delivery) Ack(context.Context) error { return d.settle(true, false) }

func (d *delivery) Nack(_ context.Context, requeue bool) error { return d.settle(false, requeue) }

func (d *delivery) settle(ack, requeue bool) error {
	if !d.settled.CompareAndSwap(false, true) {
		return nil
	}
	if !d.s.manual {
		return nil
	}
	d.s.heldMu.Lock()
	delete(d.s.held, d)
	d.s.heldMu.Unlock()
	defer func() { <-d.s.slots }()
	switch {
	case ack, !requeue:
		return d.s.consumer.Ack(d.msg)
	default:
		d.s.consumer.Nack(d.msg)
		return nil
	}
}

var (
	_ transport.Driver        = (*Driver)(nil)
	_ transport.StatsReporter = (*Driver)(nil)
)
