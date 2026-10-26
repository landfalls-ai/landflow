// Package mqtt is the MQTT 5 driver of sdks/go/transport (docs/transports.md
// "Brokers", docs/protocol.md §14.9), built on github.com/eclipse/paho.golang
// (autopaho for the connection, paho for the packets). Wire-compatible with the
// TypeScript driver @landflow/transports/mqtt.
//
//   - Topics: a channel name becomes a topic with "/" for "." ("landflow.v1.plugin.twilio"
//     → "landflow/v1/plugin/twilio"); channel names never contain "/", "+" or "#".
//   - Shared channels (request, instance) are consumed through a shared
//     subscription, "$share/<group>/<topic>", published and subscribed at QoS 1.
//     Broadcast channels (registry, control) are plain subscriptions at QoS 0.
//   - CloudEvents attributes are user properties under their bare names (no
//     prefix), the body is the payload and "content-type" is the Content Type
//     property.
//   - Replies are native: Request publishes with a Response Topic of this
//     driver's own ("<prefix>/v1/reply/<random>", subscribed at connect) and
//     random Correlation Data; Reply publishes to the request's response topic
//     with its correlation data. A connection loss fails the requests in flight.
//   - "Nobody took it": a QoS 1 publish that matched no subscription is answered
//     with PUBACK reason 0x10 "No matching subscribers" (Mosquitto, EMQX, HiveMQ
//     do; the protocol says MAY), so a publish or request to a shared channel
//     nobody consumes is Unroutable at once. There are no consumer counts, so
//     no Stats.
//   - Acknowledgement, nack and attempts: the broker's QoS 1 delivery is
//     acknowledged at once (paho's manual acknowledgements must go out in order,
//     so a slow at-least-once call would hold back every later ack; the TS
//     driver cannot defer them at all) and the driver does what core NATS does:
//     Nack(requeue) and a closed subscription republish the message on its
//     topic with a "landflow-attempt" user property (stripped before the core
//     sees it), so another member of the shared subscription takes it with
//     Attempt + 1. A process that is killed loses what it held. Prefetch is
//     honoured by holding deliveries in the driver.
//   - No buffering (clean sessions, expiry 0: a message published while no
//     replica is subscribed is dropped), TTL as the Message Expiry Interval
//     (whole seconds, rounded up), 1 MiB by default lowered to the CONNACK
//     Maximum Packet Size, no ordering keys.
//
// This package is its own Go module so sdks/go stays free of paho. Code use:
// mqtt.New(mqtt.Config{URL: "mqtt://127.0.0.1:51883"}); env use: blank-import
// the package and set LANDFLOW_MQTT_URL (LANDFLOW_MQTT_USERNAME / _PASSWORD,
// _TLS=true, _PREFIX, _CLIENT_ID).
package mqtt

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

	"github.com/eclipse/paho.golang/autopaho"
	"github.com/eclipse/paho.golang/paho"

	"github.com/landflow/landflow/sdks/go/transport"
)

// Kind is the transport kind this driver registers.
const Kind = "mqtt"

// AttemptProperty is the driver user property carrying the attempt of a republished message; it never reaches the core.
const AttemptProperty = "landflow-attempt"

// NoMatchingSubscribers is the PUBACK reason code "No matching subscribers" (MQTT 5 §3.4.2.1).
const NoMatchingSubscribers = 0x10

// requeueDelay is how long a requeued event waits before it is republished, so a draining replica does not take it straight back.
const requeueDelay = 25 * time.Millisecond

// Config configures an MQTT driver.
type Config struct {
	transport.Config
	// URL is the broker URL: "mqtt://host:1883", "mqtts://host:8883", "ws://host/mqtt" or "wss://…" (no credentials in it).
	URL string
	// Username and Password authenticate the connection (empty: none).
	Username string
	Password string
	// TLS, when set, is used for mqtts:// and wss:// URLs (default: the system roots).
	TLS *tls.Config
	// ClientID is the MQTT client id (default "landflow-<connectionId>-<random>").
	ClientID string
	// KeepAlive in seconds (default 30).
	KeepAlive uint16
	// ConnectTimeout bounds the first connection (default 10 s).
	ConnectTimeout time.Duration
	// ReconnectDelay between reconnection attempts (default 1 s).
	ReconnectDelay time.Duration
	// MaxMessageBytes the driver accepts (default 1 MiB), lowered to the broker's CONNACK Maximum Packet Size.
	MaxMessageBytes int
}

// Driver is one MQTT 5 connection (autopaho), one reply topic and any number of subscriptions.
type Driver struct {
	cfg Config

	mu         sync.Mutex
	caps       transport.Capabilities
	cm         *autopaho.ConnectionManager
	online     bool
	closed     bool
	replyTopic string
	specs      map[string]transport.ChannelSpec
	filters    map[string]int // broker subscriptions by filter, reference-counted
	subs       map[*subscription]struct{}
	pending    map[string]chan *paho.Publish // correlation data (hex) -> reply
}

// New returns an unconnected driver; defaults are filled in.
func New(cfg Config) *Driver {
	if cfg.MaxMessageBytes <= 0 {
		cfg.MaxMessageBytes = 1 << 20
	}
	if cfg.KeepAlive == 0 {
		cfg.KeepAlive = 30
	}
	if cfg.ConnectTimeout <= 0 {
		cfg.ConnectTimeout = 10 * time.Second
	}
	if cfg.ReconnectDelay <= 0 {
		cfg.ReconnectDelay = time.Second
	}
	if cfg.Prefix == "" {
		cfg.Prefix = transport.DefaultPrefix
	}
	return &Driver{
		cfg: cfg,
		caps: transport.Capabilities{
			Replies:         transport.RepliesNative,
			WorkSharing:     true,
			Buffering:       false,
			TTL:             true,
			Undeliverable:   transport.UndeliverableReported,
			Persistence:     transport.PersistenceDisk,
			MaxMessageBytes: cfg.MaxMessageBytes,
			Latency:         transport.LatencyLow,
			Headers:         true,
			OrderingKeys:    false,
			Nack:            true,
			Attempts:        true,
		},
		specs: map[string]transport.ChannelSpec{}, filters: map[string]int{}, subs: map[*subscription]struct{}{}, pending: map[string]chan *paho.Publish{},
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

// ConfigFromURL builds a Config from "mqtt://[user:pass@]host[:1883]", "mqtts://…", "tcp://", "ssl://", "ws://host/path"
// or "wss://…" and the connection options (username/password win over the URL's; TLS forces mqtts or wss; field
// client_id). Credentials never stay in the URL.
func ConfigFromURL(connectionID, rawURL string, opts transport.ConnectionOptions) (Config, error) {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || u.Host == "" {
		return Config{}, fmt.Errorf("mqtt: malformed URL %q (want mqtt://host:1883 or mqtts://host:8883)", rawURL)
	}
	scheme := strings.ToLower(u.Scheme)
	switch scheme {
	case "mqtt", "tcp":
		scheme = "mqtt"
	case "mqtts", "ssl", "tls", "mqtt+ssl", "mqtt+tls":
		scheme = "mqtts"
	case "ws", "wss":
	default:
		return Config{}, fmt.Errorf("mqtt: unsupported URL scheme %q (want mqtt://, mqtts://, ws:// or wss://)", u.Scheme)
	}
	if opts.TLS {
		if scheme == "ws" || scheme == "wss" {
			scheme = "wss"
		} else {
			scheme = "mqtts"
		}
	}
	cfg := Config{Config: transport.Config{ConnectionID: connectionID, Prefix: opts.Prefix}}
	if u.User != nil {
		cfg.Username = u.User.Username()
		cfg.Password, _ = u.User.Password()
	}
	if opts.Username != "" {
		cfg.Username, cfg.Password = opts.Username, opts.Password
	}
	u.Scheme = scheme
	u.User = nil
	cfg.URL = u.String()
	cfg.ClientID = opts.Fields["client_id"]
	return cfg, nil
}

// TopicOf is a channel name as an MQTT topic ("." → "/").
func TopicOf(channel string) string { return strings.ReplaceAll(channel, ".", "/") }

// ChannelOf is the inverse of TopicOf.
func ChannelOf(topic string) string { return strings.ReplaceAll(topic, "/", ".") }

// InferShared reports whether an undeclared channel is shared (QoS 1, shared subscription) by the core naming
// "<prefix>.v1.<role>…"; unknown roles are shared.
func InferShared(channel string) bool {
	parts := strings.Split(channel, ".")
	if len(parts) < 3 {
		return true
	}
	switch parts[2] {
	case "reply", "registry", "control":
		return false
	}
	return true
}

// Kind implements transport.Driver.
func (d *Driver) Kind() string { return Kind }

// Capabilities implements transport.Driver (MaxMessageBytes is lowered to the broker's Maximum Packet Size on connect).
func (d *Driver) Capabilities() transport.Capabilities {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.caps
}

// Config implements transport.Driver.
func (d *Driver) Config() transport.Config { return d.cfg.Config }

// MQTTConfig returns the full driver configuration.
func (d *Driver) MQTTConfig() Config { return d.cfg }

// ReplyTopic is the response topic this driver's requests use (empty before Connect).
func (d *Driver) ReplyTopic() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.replyTopic
}

func newHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Connect implements transport.Driver.
func (d *Driver) Connect(ctx context.Context) error {
	d.mu.Lock()
	if d.closed {
		d.mu.Unlock()
		return fmt.Errorf("mqtt: driver closed: %w", transport.ErrNotConnected)
	}
	if d.cm != nil {
		d.mu.Unlock()
		return nil
	}
	d.replyTopic = TopicOf(d.cfg.Prefix) + "/v1/reply/" + newHex(8)
	d.mu.Unlock()
	serverURL, err := url.Parse(d.cfg.URL)
	if err != nil {
		return fmt.Errorf("mqtt: malformed URL %q: %w", d.cfg.URL, err)
	}
	clientID := d.cfg.ClientID
	if clientID == "" {
		clientID = "landflow-" + d.cfg.ConnectionID + "-" + newHex(4)
	}
	var connectErr atomic.Value
	cfg := autopaho.ClientConfig{
		ServerUrls:                    []*url.URL{serverURL},
		TlsCfg:                        d.cfg.TLS,
		KeepAlive:                     d.cfg.KeepAlive,
		CleanStartOnInitialConnection: true,
		SessionExpiryInterval:         0,
		ConnectTimeout:                d.cfg.ConnectTimeout,
		ReconnectBackoff:              func(int) time.Duration { return d.cfg.ReconnectDelay },
		OnConnectionUp:                func(cm *autopaho.ConnectionManager, ca *paho.Connack) { go d.onUp(cm, ca) },
		OnConnectionDown:              func() bool { d.onDown(); return true },
		OnConnectError:                func(err error) { connectErr.Store(err) },
		ClientConfig: paho.ClientConfig{
			ClientID:          clientID,
			OnPublishReceived: []func(paho.PublishReceived) (bool, error){d.onPublish},
			OnClientError:     func(error) {},
		},
	}
	if d.cfg.Username != "" {
		cfg.SetUsernamePassword(d.cfg.Username, []byte(d.cfg.Password))
	}
	cm, err := autopaho.NewConnection(context.Background(), cfg)
	if err != nil {
		return fmt.Errorf("mqtt: %w", err)
	}
	waitCtx, cancel := context.WithTimeout(ctx, d.cfg.ConnectTimeout+time.Second)
	defer cancel()
	if err := cm.AwaitConnection(waitCtx); err != nil {
		dctx, dcancel := context.WithTimeout(context.Background(), time.Second)
		_ = cm.Disconnect(dctx)
		dcancel()
		if first, ok := connectErr.Load().(error); ok && first != nil {
			err = first
		}
		return fmt.Errorf("mqtt: cannot connect to %s: %w", d.cfg.URL, err)
	}
	d.mu.Lock()
	d.cm = cm
	d.online = true
	replyTopic := d.replyTopic
	d.mu.Unlock()
	if _, err := cm.Subscribe(ctx, &paho.Subscribe{Subscriptions: []paho.SubscribeOptions{{Topic: replyTopic, QoS: 1}}}); err != nil {
		dctx, dcancel := context.WithTimeout(context.Background(), time.Second)
		_ = cm.Disconnect(dctx)
		dcancel()
		d.mu.Lock()
		d.cm, d.online = nil, false
		d.mu.Unlock()
		return fmt.Errorf("mqtt: cannot subscribe to the reply topic: %w", err)
	}
	return nil
}

// onUp records the CONNACK limits and, after a reconnect (a new clean session), re-subscribes everything.
func (d *Driver) onUp(cm *autopaho.ConnectionManager, ca *paho.Connack) {
	d.mu.Lock()
	if ca != nil && ca.Properties != nil && ca.Properties.MaximumPacketSize != nil && *ca.Properties.MaximumPacketSize > 1024 {
		if limit := int(*ca.Properties.MaximumPacketSize) - 1024; limit < d.cfg.MaxMessageBytes {
			d.caps.MaxMessageBytes = limit
		}
	}
	first := d.cm == nil
	d.online = true
	subs := make([]paho.SubscribeOptions, 0, len(d.filters)+1)
	if !first {
		subs = append(subs, paho.SubscribeOptions{Topic: d.replyTopic, QoS: 1})
		for filter := range d.filters {
			qos := byte(0)
			if strings.HasPrefix(filter, "$share/") {
				qos = 1
			}
			subs = append(subs, paho.SubscribeOptions{Topic: filter, QoS: qos})
		}
	}
	d.mu.Unlock()
	if len(subs) > 0 {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = cm.Subscribe(ctx, &paho.Subscribe{Subscriptions: subs})
	}
}

func (d *Driver) onDown() {
	d.mu.Lock()
	d.online = false
	pending := d.pending
	d.pending = map[string]chan *paho.Publish{}
	d.mu.Unlock()
	for _, w := range pending {
		close(w)
	}
}

func (d *Driver) manager() (*autopaho.ConnectionManager, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.cm == nil || !d.online || d.closed {
		return nil, fmt.Errorf("mqtt: %w", transport.ErrNotConnected)
	}
	return d.cm, nil
}

func (d *Driver) isShared(channel string) bool {
	d.mu.Lock()
	spec, ok := d.specs[channel]
	d.mu.Unlock()
	if ok {
		return spec.Delivery == transport.DeliveryShared
	}
	return InferShared(channel)
}

// Declare implements transport.Driver: topics need no creation, so it records what each channel is.
func (d *Driver) Declare(ctx context.Context, channels []transport.ChannelSpec) error {
	if _, err := d.manager(); err != nil {
		return err
	}
	d.mu.Lock()
	for _, spec := range channels {
		d.specs[spec.Name] = spec
	}
	d.mu.Unlock()
	return nil
}

// expirySeconds is the Message Expiry Interval for a TTL (whole seconds, minimum 1).
func expirySeconds(ttl time.Duration) uint32 {
	s := uint32((ttl + time.Second - 1) / time.Second)
	if s < 1 {
		s = 1
	}
	return s
}

func properties(event transport.WireEvent, ttl time.Duration) *paho.PublishProperties {
	p := &paho.PublishProperties{}
	for name, value := range event.Headers {
		if name == "content-type" {
			p.ContentType = value
		} else {
			p.User.Add(name, value)
		}
	}
	if ttl > 0 {
		e := expirySeconds(ttl)
		p.MessageExpiry = &e
	}
	return p
}

func (d *Driver) publish(ctx context.Context, cm *autopaho.ConnectionManager, pub *paho.Publish) (transport.PublishOutcome, error) {
	resp, err := cm.Publish(ctx, pub)
	if err != nil {
		if errors.Is(err, autopaho.ConnectionDownError) {
			return "", fmt.Errorf("mqtt: %w", transport.ErrNotConnected)
		}
		return "", fmt.Errorf("mqtt: publish to %s: %w", pub.Topic, err)
	}
	if pub.QoS == 1 && resp != nil && resp.ReasonCode == NoMatchingSubscribers {
		return transport.Unroutable, nil
	}
	return transport.Accepted, nil
}

// Publish implements transport.Driver: QoS 1 on shared channels (PUBACK 0x10 → Unroutable), QoS 0 on broadcast ones.
func (d *Driver) Publish(ctx context.Context, channel string, event transport.WireEvent, opts transport.PublishOptions) (transport.PublishOutcome, error) {
	cm, err := d.manager()
	if err != nil {
		return "", err
	}
	qos := byte(0)
	if d.isShared(channel) {
		qos = 1
	}
	return d.publish(ctx, cm, &paho.Publish{Topic: TopicOf(channel), QoS: qos, Payload: event.Body, Properties: properties(event, opts.TTL)})
}

// Request implements transport.Requester with a response topic and correlation data.
func (d *Driver) Request(ctx context.Context, channel string, event transport.WireEvent, opts transport.RequestOptions) (transport.RequestResult, error) {
	cm, err := d.manager()
	if err != nil {
		return transport.RequestResult{}, err
	}
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	correlation := make([]byte, 12)
	_, _ = rand.Read(correlation)
	key := hex.EncodeToString(correlation)
	wait := make(chan *paho.Publish, 1)
	d.mu.Lock()
	d.pending[key] = wait
	replyTopic := d.replyTopic
	d.mu.Unlock()
	forget := func() {
		d.mu.Lock()
		delete(d.pending, key)
		d.mu.Unlock()
	}
	props := properties(event, timeout)
	props.ResponseTopic = replyTopic
	props.CorrelationData = correlation
	outcome, err := d.publish(ctx, cm, &paho.Publish{Topic: TopicOf(channel), QoS: 1, Payload: event.Body, Properties: props})
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
	case pub, ok := <-wait:
		if !ok || pub == nil {
			return transport.RequestResult{}, errors.New("mqtt: connection lost while waiting for the reply")
		}
		return transport.RequestResult{Outcome: transport.RequestReplied, Event: wireEvent(pub)}, nil
	case <-timer.C:
		forget()
		return transport.RequestResult{Outcome: transport.RequestTimeout}, nil
	case <-ctx.Done():
		forget()
		return transport.RequestResult{}, ctx.Err()
	}
}

// wireEvent is a received packet as a wire event: user properties (lower-cased, the driver's own dropped) and the Content Type.
func wireEvent(pub *paho.Publish) transport.WireEvent {
	headers := map[string]string{}
	if pub.Properties != nil {
		for _, u := range pub.Properties.User {
			name := strings.ToLower(u.Key)
			if name == AttemptProperty {
				continue
			}
			if _, dup := headers[name]; !dup {
				headers[name] = u.Value
			}
		}
		if pub.Properties.ContentType != "" {
			headers["content-type"] = pub.Properties.ContentType
		}
	}
	return transport.WireEvent{Headers: headers, Body: pub.Payload}
}

// attemptOf is the attempt a received packet carries (1 unless republished).
func attemptOf(pub *paho.Publish) int {
	if pub.Properties != nil {
		if n, err := strconv.Atoi(pub.Properties.User.Get(AttemptProperty)); err == nil && n > 0 {
			return n
		}
	}
	return 1
}

// onPublish routes an inbound packet to the reply waiter or to every local subscription of its topic. It never blocks.
func (d *Driver) onPublish(pr paho.PublishReceived) (bool, error) {
	pub := pr.Packet
	d.mu.Lock()
	if pub.Topic == d.replyTopic {
		var key string
		if pub.Properties != nil {
			key = hex.EncodeToString(pub.Properties.CorrelationData)
		}
		w := d.pending[key]
		delete(d.pending, key)
		d.mu.Unlock()
		if w != nil {
			w <- pub
		}
		return true, nil
	}
	subs := make([]*subscription, 0, 2)
	for s := range d.subs {
		if s.topic == pub.Topic {
			subs = append(subs, s)
		}
	}
	d.mu.Unlock()
	for _, s := range subs {
		s.enqueue(pub)
	}
	return len(subs) > 0, nil
}

// Consume implements transport.Driver: "$share/<group>/<topic>" at QoS 1 with a group, the plain topic at QoS 0 without.
func (d *Driver) Consume(ctx context.Context, channel string, opts transport.ConsumeOptions, handler transport.Handler) (transport.Subscription, error) {
	cm, err := d.manager()
	if err != nil {
		return nil, err
	}
	topic := TopicOf(channel)
	filter := topic
	qos := byte(0)
	if opts.Group != "" {
		filter = "$share/" + opts.Group + "/" + topic
		qos = 1
	}
	runCtx, cancel := context.WithCancel(context.Background())
	s := &subscription{
		d: d, channel: channel, topic: topic, filter: filter, handler: handler, ctx: runCtx, cancel: cancel,
		manual: opts.AckMode != transport.AckAuto && opts.Group != "", prefetch: max(opts.Prefetch, 1), held: map[*held]struct{}{},
	}
	d.mu.Lock()
	refs := d.filters[filter]
	d.filters[filter] = refs + 1
	d.subs[s] = struct{}{}
	d.mu.Unlock()
	if refs == 0 {
		if _, err := cm.Subscribe(ctx, &paho.Subscribe{Subscriptions: []paho.SubscribeOptions{{Topic: filter, QoS: qos}}}); err != nil {
			d.mu.Lock()
			delete(d.subs, s)
			if d.filters[filter] <= 1 {
				delete(d.filters, filter)
			} else {
				d.filters[filter]--
			}
			d.mu.Unlock()
			cancel()
			return nil, fmt.Errorf("mqtt: subscribe %s: %w", filter, err)
		}
	}
	return s, nil
}

// republish puts a delivery back on its topic with the next attempt number, keeping its response topic and correlation data.
func (d *Driver) republish(ctx context.Context, cm *autopaho.ConnectionManager, pub *paho.Publish, attempt int) {
	props := &paho.PublishProperties{}
	if pub.Properties != nil {
		props.ContentType = pub.Properties.ContentType
		props.ResponseTopic = pub.Properties.ResponseTopic
		props.CorrelationData = pub.Properties.CorrelationData
		props.MessageExpiry = pub.Properties.MessageExpiry
		props.PayloadFormat = pub.Properties.PayloadFormat
		for _, u := range pub.Properties.User {
			if strings.ToLower(u.Key) != AttemptProperty {
				props.User.Add(u.Key, u.Value)
			}
		}
	}
	props.User.Add(AttemptProperty, strconv.Itoa(attempt))
	_, _ = cm.Publish(ctx, &paho.Publish{Topic: pub.Topic, QoS: 1, Payload: pub.Payload, Properties: props})
}

// Close implements transport.Driver: leaves the subscriptions, republishes what they held and disconnects.
func (d *Driver) Close() error {
	d.mu.Lock()
	if d.closed {
		d.mu.Unlock()
		return nil
	}
	d.closed = true
	cm := d.cm
	online := d.online
	filters := make([]string, 0, len(d.filters))
	for f := range d.filters {
		filters = append(filters, f)
	}
	d.filters = map[string]int{}
	subs := make([]*subscription, 0, len(d.subs))
	for s := range d.subs {
		subs = append(subs, s)
	}
	d.subs = map[*subscription]struct{}{}
	pending := d.pending
	d.pending = map[string]chan *paho.Publish{}
	d.mu.Unlock()
	for _, w := range pending {
		close(w)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if cm != nil && online && len(filters) > 0 {
		_, _ = cm.Unsubscribe(ctx, &paho.Unsubscribe{Topics: filters})
	}
	for _, s := range subs {
		s.closeLocal(ctx, cm != nil && online)
	}
	if cm != nil {
		return cm.Disconnect(ctx)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Subscriptions and deliveries
// ---------------------------------------------------------------------------

type subscription struct {
	d        *Driver
	channel  string
	topic    string
	filter   string
	handler  transport.Handler
	ctx      context.Context // cancelled when the subscription closes
	cancel   context.CancelFunc
	manual   bool
	prefetch int

	mu       sync.Mutex
	queue    []*held
	held     map[*held]struct{}
	inFlight int
	closed   bool
}

type held struct {
	pub     *paho.Publish
	attempt int
}

func (s *subscription) Channel() string { return s.channel }

func (s *subscription) enqueue(pub *paho.Publish) {
	h := &held{pub: pub, attempt: attemptOf(pub)}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.queue = append(s.queue, h)
	s.mu.Unlock()
	s.pump()
}

// pump starts handlers while slots are free (manual mode holds at most prefetch; auto mode runs everything).
func (s *subscription) pump() {
	for {
		s.mu.Lock()
		if s.closed || len(s.queue) == 0 || (s.manual && s.inFlight >= s.prefetch) {
			s.mu.Unlock()
			return
		}
		h := s.queue[0]
		s.queue = s.queue[1:]
		s.inFlight++
		if s.manual {
			s.held[h] = struct{}{}
		}
		s.mu.Unlock()
		del := &delivery{s: s, h: h}
		if !s.manual {
			del.settled.Store(true)
		}
		go func() {
			s.handler(s.ctx, wireEvent(h.pub), del)
			if !s.manual {
				s.mu.Lock()
				s.inFlight--
				s.mu.Unlock()
				s.pump()
			}
		}()
	}
}

// Close leaves the broker subscription (when this was its last local consumer) and republishes what it held.
func (s *subscription) Close(ctx context.Context) error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.mu.Unlock()
	d := s.d
	d.mu.Lock()
	delete(d.subs, s)
	left := d.filters[s.filter] - 1
	if left <= 0 {
		delete(d.filters, s.filter)
	} else {
		d.filters[s.filter] = left
	}
	cm, online := d.cm, d.online
	d.mu.Unlock()
	if left <= 0 && cm != nil && online {
		_, _ = cm.Unsubscribe(ctx, &paho.Unsubscribe{Topics: []string{s.filter}})
	}
	s.closeLocal(ctx, cm != nil && online)
	return nil
}

func (s *subscription) closeLocal(ctx context.Context, republish bool) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	orphans := make([]*held, 0, len(s.held)+len(s.queue))
	for h := range s.held {
		orphans = append(orphans, h)
	}
	orphans = append(orphans, s.queue...)
	s.held = map[*held]struct{}{}
	s.queue = nil
	s.mu.Unlock()
	s.cancel()
	if !republish {
		return
	}
	s.d.mu.Lock()
	cm := s.d.cm
	s.d.mu.Unlock()
	if cm == nil {
		return
	}
	for _, h := range orphans {
		s.d.republish(ctx, cm, h.pub, h.attempt+1)
	}
}

type delivery struct {
	s       *subscription
	h       *held
	settled atomic.Bool
}

func (d *delivery) Attempt() int { return d.h.attempt }

func (d *delivery) settle() bool {
	if !d.settled.CompareAndSwap(false, true) {
		return false
	}
	s := d.s
	s.mu.Lock()
	delete(s.held, d.h)
	s.inFlight--
	s.mu.Unlock()
	s.pump()
	return true
}

func (d *delivery) Ack(ctx context.Context) error {
	d.settle()
	return nil
}

// Nack: requeue republishes the message with the next attempt; otherwise it is dropped.
func (d *delivery) Nack(ctx context.Context, requeue bool) error {
	if !d.settle() || !requeue {
		return nil
	}
	s := d.s
	s.mu.Lock()
	closed := s.closed
	s.mu.Unlock()
	if closed {
		return nil
	}
	go func() {
		time.Sleep(requeueDelay)
		cm, err := s.d.manager()
		if err != nil {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		s.d.republish(ctx, cm, d.h.pub, d.h.attempt+1)
	}()
	return nil
}

// Reply implements transport.Replier: the response goes to the request's response topic with its correlation data.
func (d *delivery) Reply(ctx context.Context, event transport.WireEvent) error {
	p := d.h.pub.Properties
	if p == nil || p.ResponseTopic == "" {
		return errors.New("mqtt: the request carries no response topic")
	}
	cm, err := d.s.d.manager()
	if err != nil {
		return err
	}
	props := properties(event, 0)
	props.CorrelationData = p.CorrelationData
	// Reason 0x10 (the requester is gone) is the normal outcome of a late reply, not an error.
	_, err = d.s.d.publish(ctx, cm, &paho.Publish{Topic: p.ResponseTopic, QoS: 1, Payload: event.Body, Properties: props})
	return err
}

var (
	_ transport.Driver    = (*Driver)(nil)
	_ transport.Requester = (*Driver)(nil)
	_ transport.Replier   = (*delivery)(nil)
)
