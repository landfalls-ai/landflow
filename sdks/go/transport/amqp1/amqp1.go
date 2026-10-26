// Package amqp1 is the AMQP 1.0 driver of sdks/go/transport (ActiveMQ Artemis;
// docs/transports.md "Brokers", docs/protocol.md §14.9), built on
// github.com/Azure/go-amqp. Wire-compatible with the TypeScript driver
// @landflow/transports/amqp1.
//
//   - Shared channels (request, instance) are anycast addresses with a queue of
//     the same name: senders and receivers attach with the "queue" terminus
//     capability, so Artemis auto-creates the address and its queue on first
//     use and the queue buffers while no replica is attached. Competing
//     receivers share it; prefetch is link credit (replenished as deliveries
//     settle).
//   - Broadcast channels (registry, control) are multicast addresses: links
//     attach with the "topic" capability and the broker gives each receiver a
//     volatile subscription queue.
//   - CloudEvents attributes are application properties under
//     "cloudEvents_<name>", the body is a data section and "content-type" is
//     the message's content-type property.
//   - Replies are native: each driver opens a dynamic receiver (a broker-named
//     temporary queue, gone with the connection); Request sets reply-to to it
//     with a random correlation-id, Reply sends to the request's reply-to with
//     its correlation-id. A connection loss fails the requests in flight.
//   - Settlement: Ack is accepted; Nack(requeue) is modified{delivery-failed},
//     which puts the message back with delivery-count incremented (Attempt =
//     delivery-count + 1); Nack(drop) is accepted too (rejected would dead-letter
//     or redeliver, depending on the broker); a closed subscription settles what
//     it holds as modified{delivery-failed} and detaches. TTL is the header's
//     ttl (Artemis checks expiry on delivery). Ordering keys are the message
//     group-id (Artemis message groups).
//   - "Nobody took it" is inferred: Stats asks the broker's management address
//     (activemq.management) for ConsumerCount and MessageCount of queue.<channel>.
//
// This package is its own Go module so sdks/go stays free of go-amqp. Code use:
// amqp1.New(amqp1.Config{URL: "amqp://127.0.0.1:55674", Username: …, Password: …});
// env use: blank-import the package and set LANDFLOW_AMQP1_URL
// (LANDFLOW_AMQP1_USERNAME / _PASSWORD fill credentials; _TLS=true; _PREFIX).
package amqp1

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Azure/go-amqp"

	"github.com/landflow/landflow/sdks/go/transport"
)

// Kind is the transport kind this driver registers.
const Kind = "amqp1"

// HeaderPrefix is the AMQP protocol binding's application-property prefix for CloudEvents attributes.
const HeaderPrefix = "cloudEvents_"

// ManagementAddress is Artemis's management address (JMX over AMQP).
const ManagementAddress = "activemq.management"

const (
	defaultMaxMessageBytes = 1 << 20
	linkTimeout            = 10 * time.Second
	managementTimeout      = 3 * time.Second
	reconnectMin           = time.Second
	reconnectMax           = 30 * time.Second
)

// Config configures an AMQP 1.0 driver.
type Config struct {
	transport.Config
	// URL is the broker URL ("amqp://host:5672" or "amqps://host:5671"; credentials may be in it).
	URL string
	// Username and Password authenticate with SASL PLAIN (they replace the URL's); empty: SASL ANONYMOUS.
	Username string
	Password string
	// TLS, when set, is used for amqps:// URLs (default: the system roots).
	TLS *tls.Config
	// IdleTimeout is the AMQP idle timeout (heartbeat; default 60 s).
	IdleTimeout time.Duration
	// ConnectTimeout bounds a connection attempt (default 10 s).
	ConnectTimeout time.Duration
	// MaxMessageBytes the driver accepts (default 1 MiB).
	MaxMessageBytes int
	// ReconnectMin / ReconnectMax bound the reconnect backoff (default 1 s … 30 s).
	ReconnectMin time.Duration
	ReconnectMax time.Duration
}

// Driver is one AMQP connection with one session, cached senders, a dynamic reply receiver and one receiver per subscription.
type Driver struct {
	cfg  Config
	caps transport.Capabilities

	mu        sync.Mutex
	conn      *amqp.Conn
	session   *amqp.Session
	state     string // "new", "connected", "reconnecting", "closed"
	replyAddr string
	replyRecv *amqp.Receiver
	roles     map[string]string // channel -> "queue" | "topic"
	specs     map[string]transport.ChannelSpec
	senders   map[string]*amqp.Sender
	senderMu  map[string]*sync.Mutex
	subs      map[*subscription]struct{}
	pending   map[string]chan *amqp.Message
	attempt   int
}

// New returns an unconnected driver; defaults are filled in.
func New(cfg Config) *Driver {
	if cfg.MaxMessageBytes <= 0 {
		cfg.MaxMessageBytes = defaultMaxMessageBytes
	}
	if cfg.IdleTimeout <= 0 {
		cfg.IdleTimeout = time.Minute
	}
	if cfg.ConnectTimeout <= 0 {
		cfg.ConnectTimeout = 10 * time.Second
	}
	if cfg.ReconnectMin <= 0 {
		cfg.ReconnectMin = reconnectMin
	}
	if cfg.ReconnectMax <= 0 {
		cfg.ReconnectMax = reconnectMax
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
			Undeliverable:   transport.UndeliverableInferred,
			Persistence:     transport.PersistenceDisk,
			MaxMessageBytes: cfg.MaxMessageBytes,
			Latency:         transport.LatencyMedium,
			Headers:         true,
			OrderingKeys:    true,
			Nack:            true,
			Attempts:        true,
		},
		state: "new", roles: map[string]string{}, specs: map[string]transport.ChannelSpec{}, senders: map[string]*amqp.Sender{},
		senderMu: map[string]*sync.Mutex{}, subs: map[*subscription]struct{}{}, pending: map[string]chan *amqp.Message{},
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

// ConfigFromURL builds a Config from "amqp://[user:pass@]host[:5672]" or "amqps://…" ("amqp+ssl://" too) and the
// connection options (username/password win over the URL's; TLS forces amqps). Credentials never stay in the URL.
func ConfigFromURL(connectionID, rawURL string, opts transport.ConnectionOptions) (Config, error) {
	raw := strings.TrimSpace(rawURL)
	for _, alias := range []string{"amqp+ssl://", "amqp+tls://"} {
		if strings.HasPrefix(strings.ToLower(raw), alias) {
			raw = "amqps://" + raw[len(alias):]
		}
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return Config{}, fmt.Errorf("amqp1: malformed URL %q (want amqp://user:pass@host:5672)", rawURL)
	}
	switch strings.ToLower(u.Scheme) {
	case "amqp":
		u.Scheme = "amqp"
		if opts.TLS {
			u.Scheme = "amqps"
		}
	case "amqps":
		u.Scheme = "amqps"
	default:
		return Config{}, fmt.Errorf("amqp1: unsupported URL scheme %q (want amqp:// or amqps://)", u.Scheme)
	}
	cfg := Config{Config: transport.Config{ConnectionID: connectionID, Prefix: opts.Prefix}}
	if u.User != nil {
		cfg.Username = u.User.Username()
		cfg.Password, _ = u.User.Password()
	}
	if opts.Username != "" {
		cfg.Username, cfg.Password = opts.Username, opts.Password
	}
	u.User = nil
	cfg.URL = u.String()
	return cfg, nil
}

// InferRole is the role of a channel the driver has not declared itself: "<prefix>.v1.<role>…" (§14.2), "queue" otherwise.
func InferRole(channel string) string {
	parts := strings.Split(channel, ".")
	if len(parts) >= 3 {
		switch parts[2] {
		case "reply", "registry", "control":
			return "topic"
		}
	}
	return "queue"
}

// Kind implements transport.Driver.
func (d *Driver) Kind() string { return Kind }

// Capabilities implements transport.Driver.
func (d *Driver) Capabilities() transport.Capabilities { return d.caps }

// Config implements transport.Driver.
func (d *Driver) Config() transport.Config { return d.cfg.Config }

// AMQP1Config returns the full driver configuration.
func (d *Driver) AMQP1Config() Config { return d.cfg }

func newHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Connect implements transport.Driver.
func (d *Driver) Connect(ctx context.Context) error {
	d.mu.Lock()
	if d.state == "closed" {
		d.mu.Unlock()
		return fmt.Errorf("amqp1: driver closed: %w", transport.ErrNotConnected)
	}
	if d.state != "new" {
		d.mu.Unlock()
		return nil
	}
	d.mu.Unlock()
	if err := d.open(ctx); err != nil {
		return fmt.Errorf("amqp1: cannot connect to %s: %w", d.cfg.URL, err)
	}
	d.mu.Lock()
	d.state = "connected"
	d.mu.Unlock()
	return nil
}

// open dials, opens the session and the dynamic reply receiver, and watches the connection.
func (d *Driver) open(ctx context.Context) error {
	dialCtx, cancel := context.WithTimeout(ctx, d.cfg.ConnectTimeout)
	defer cancel()
	opts := &amqp.ConnOptions{ContainerID: "landflow-" + d.cfg.ConnectionID + "-" + newHex(4), IdleTimeout: d.cfg.IdleTimeout, TLSConfig: d.cfg.TLS}
	if d.cfg.Username != "" {
		opts.SASLType = amqp.SASLTypePlain(d.cfg.Username, d.cfg.Password)
	} else {
		opts.SASLType = amqp.SASLTypeAnonymous()
	}
	conn, err := amqp.Dial(dialCtx, d.cfg.URL, opts)
	if err != nil {
		return err
	}
	session, err := conn.NewSession(dialCtx, nil)
	if err != nil {
		conn.Close()
		return fmt.Errorf("open session: %w", err)
	}
	reply, err := session.NewReceiver(dialCtx, "", &amqp.ReceiverOptions{DynamicAddress: true, Credit: 1024, SourceExpiryPolicy: amqp.ExpiryPolicyLinkDetach})
	if err != nil {
		conn.Close()
		return fmt.Errorf("open the reply receiver: %w", err)
	}
	d.mu.Lock()
	d.conn, d.session, d.replyRecv, d.replyAddr = conn, session, reply, reply.Address()
	d.senders = map[string]*amqp.Sender{}
	d.mu.Unlock()
	go d.readReplies(conn, reply)
	go d.watch(conn)
	return nil
}

// readReplies resolves pending requests (and management calls) by correlation id.
func (d *Driver) readReplies(conn *amqp.Conn, reply *amqp.Receiver) {
	ctx := context.Background()
	for {
		msg, err := reply.Receive(ctx, nil)
		if err != nil {
			return
		}
		_ = reply.AcceptMessage(ctx, msg)
		var key string
		if msg.Properties != nil && msg.Properties.CorrelationID != nil {
			key = fmt.Sprint(msg.Properties.CorrelationID)
		}
		d.mu.Lock()
		w := d.pending[key]
		delete(d.pending, key)
		d.mu.Unlock()
		if w != nil {
			w <- msg
		}
	}
}

// watch fails the requests in flight when the connection ends and reconnects with backoff.
func (d *Driver) watch(conn *amqp.Conn) {
	<-conn.Done()
	d.mu.Lock()
	if d.conn != conn {
		d.mu.Unlock()
		return
	}
	d.conn, d.session, d.replyRecv = nil, nil, nil
	d.senders = map[string]*amqp.Sender{}
	pending := d.pending
	d.pending = map[string]chan *amqp.Message{}
	for s := range d.subs {
		s.detach()
	}
	closed := d.state == "closed"
	if !closed {
		d.state = "reconnecting"
	}
	d.mu.Unlock()
	for _, w := range pending {
		close(w)
	}
	if closed {
		return
	}
	for {
		d.mu.Lock()
		if d.state != "reconnecting" {
			d.mu.Unlock()
			return
		}
		n := d.attempt
		d.attempt++
		d.mu.Unlock()
		delay := d.cfg.ReconnectMin << min(n, 10)
		if delay > d.cfg.ReconnectMax || delay <= 0 {
			delay = d.cfg.ReconnectMax
		}
		time.Sleep(delay)
		d.mu.Lock()
		if d.state != "reconnecting" {
			d.mu.Unlock()
			return
		}
		d.mu.Unlock()
		if err := d.open(context.Background()); err != nil {
			continue
		}
		d.mu.Lock()
		subs := make([]*subscription, 0, len(d.subs))
		for s := range d.subs {
			subs = append(subs, s)
		}
		d.attempt = 0
		d.state = "connected"
		d.mu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), linkTimeout)
		for _, s := range subs {
			_ = d.attach(ctx, s)
		}
		cancel()
		return
	}
}

func (d *Driver) live() (*amqp.Session, string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.state != "connected" || d.session == nil {
		return nil, "", fmt.Errorf("amqp1: %w", transport.ErrNotConnected)
	}
	return d.session, d.replyAddr, nil
}

func (d *Driver) roleOf(channel string) string {
	d.mu.Lock()
	defer d.mu.Unlock()
	if role, ok := d.roles[channel]; ok {
		return role
	}
	role := InferRole(channel)
	d.roles[channel] = role
	return role
}

// Declare implements transport.Driver: Artemis creates addresses and queues when the first link attaches (the terminus
// capability picks anycast or multicast), so declaring records what each channel is.
func (d *Driver) Declare(ctx context.Context, channels []transport.ChannelSpec) error {
	if _, _, err := d.live(); err != nil {
		return err
	}
	d.mu.Lock()
	for _, spec := range channels {
		d.specs[spec.Name] = spec
		if spec.Delivery == transport.DeliveryBroadcast {
			d.roles[spec.Name] = "topic"
		} else {
			d.roles[spec.Name] = "queue"
		}
	}
	d.mu.Unlock()
	return nil
}

// sender returns the cached sender for an address and terminus capability (empty: none), opening it on first use.
func (d *Driver) sender(ctx context.Context, address, capability string) (*amqp.Sender, error) {
	session, _, err := d.live()
	if err != nil {
		return nil, err
	}
	key := capability + ":" + address
	d.mu.Lock()
	lock := d.senderMu[key]
	if lock == nil {
		lock = &sync.Mutex{}
		d.senderMu[key] = lock
	}
	d.mu.Unlock()
	lock.Lock()
	defer lock.Unlock()
	d.mu.Lock()
	s := d.senders[key]
	d.mu.Unlock()
	if s != nil {
		return s, nil
	}
	opts := &amqp.SenderOptions{}
	if capability != "" {
		opts.TargetCapabilities = []string{capability}
	}
	openCtx, cancel := context.WithTimeout(ctx, linkTimeout)
	defer cancel()
	s, err = session.NewSender(openCtx, address, opts)
	if err != nil {
		return nil, fmt.Errorf("amqp1: open sender to %s: %w", address, err)
	}
	d.mu.Lock()
	if d.session == session {
		d.senders[key] = s
	}
	d.mu.Unlock()
	return s, nil
}

// message builds the AMQP message for a wire event.
func message(event transport.WireEvent, durable bool, ttl time.Duration, groupID string) *amqp.Message {
	msg := &amqp.Message{Data: [][]byte{event.Body}, ApplicationProperties: map[string]any{}, Header: &amqp.MessageHeader{Durable: durable}, Properties: &amqp.MessageProperties{}}
	if event.Body == nil {
		msg.Data = [][]byte{{}}
	}
	for name, value := range transport.PrefixHeaders(event.Headers, HeaderPrefix) {
		if name == "content-type" {
			ct := value
			msg.Properties.ContentType = &ct
		} else {
			msg.ApplicationProperties[name] = value
		}
	}
	if ttl > 0 {
		msg.Header.TTL = max(ttl, time.Millisecond)
	}
	if groupID != "" {
		g := groupID
		msg.Properties.GroupID = &g
	}
	return msg
}

// send delivers one message and waits for the broker to accept it.
func (d *Driver) send(ctx context.Context, address, capability string, msg *amqp.Message) error {
	s, err := d.sender(ctx, address, capability)
	if err != nil {
		return err
	}
	if err := s.Send(ctx, msg, nil); err != nil {
		var connErr *amqp.ConnError
		var linkErr *amqp.LinkError
		if errors.As(err, &linkErr) || errors.As(err, &connErr) {
			d.mu.Lock()
			if d.senders[capability+":"+address] == s {
				delete(d.senders, capability+":"+address)
			}
			d.mu.Unlock()
		}
		return fmt.Errorf("amqp1: send to %s: %w", address, err)
	}
	return nil
}

func (d *Driver) durable(channel, role string) bool {
	d.mu.Lock()
	spec, ok := d.specs[channel]
	d.mu.Unlock()
	if ok {
		return spec.Durable
	}
	return role == "queue"
}

// Publish implements transport.Driver.
func (d *Driver) Publish(ctx context.Context, channel string, event transport.WireEvent, opts transport.PublishOptions) (transport.PublishOutcome, error) {
	role := d.roleOf(channel)
	if err := d.send(ctx, channel, role, message(event, d.durable(channel, role), opts.TTL, opts.OrderingKey)); err != nil {
		return "", err
	}
	return transport.Accepted, nil
}

// Request implements transport.Requester with the dynamic reply queue.
func (d *Driver) Request(ctx context.Context, channel string, event transport.WireEvent, opts transport.RequestOptions) (transport.RequestResult, error) {
	_, replyAddr, err := d.live()
	if err != nil {
		return transport.RequestResult{}, err
	}
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	role := d.roleOf(channel)
	msg := message(event, d.durable(channel, role), timeout, opts.OrderingKey)
	key := newHex(12)
	msg.Properties.ReplyTo = &replyAddr
	msg.Properties.CorrelationID = key
	wait := make(chan *amqp.Message, 1)
	d.mu.Lock()
	d.pending[key] = wait
	d.mu.Unlock()
	forget := func() {
		d.mu.Lock()
		delete(d.pending, key)
		d.mu.Unlock()
	}
	if err := d.send(ctx, channel, role, msg); err != nil {
		forget()
		return transport.RequestResult{}, err
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case reply, ok := <-wait:
		if !ok || reply == nil {
			return transport.RequestResult{}, errors.New("amqp1: connection lost while waiting for the reply")
		}
		return transport.RequestResult{Outcome: transport.RequestReplied, Event: wireEvent(reply)}, nil
	case <-timer.C:
		forget()
		return transport.RequestResult{Outcome: transport.RequestTimeout}, nil
	case <-ctx.Done():
		forget()
		return transport.RequestResult{}, ctx.Err()
	}
}

// wireEvent is a received message as a wire event.
func wireEvent(msg *amqp.Message) transport.WireEvent {
	headers := make(map[string]string, len(msg.ApplicationProperties)+1)
	for name, value := range msg.ApplicationProperties {
		switch v := value.(type) {
		case string:
			headers[name] = v
		case []byte:
			headers[name] = string(v)
		case nil:
		default:
			headers[name] = fmt.Sprint(v)
		}
	}
	if msg.Properties != nil && msg.Properties.ContentType != nil {
		headers["content-type"] = *msg.Properties.ContentType
	}
	return transport.WireEvent{Headers: transport.UnprefixHeaders(headers, HeaderPrefix), Body: body(msg)}
}

// body is the message body as bytes: data sections, or an amqp-value string (management replies).
func body(msg *amqp.Message) []byte {
	if len(msg.Data) > 0 {
		if len(msg.Data) == 1 {
			return msg.Data[0]
		}
		var out []byte
		for _, part := range msg.Data {
			out = append(out, part...)
		}
		return out
	}
	switch v := msg.Value.(type) {
	case string:
		return []byte(v)
	case []byte:
		return v
	case nil:
		return nil
	default:
		b, _ := json.Marshal(v)
		return b
	}
}

// Consume implements transport.Driver.
func (d *Driver) Consume(ctx context.Context, channel string, opts transport.ConsumeOptions, handler transport.Handler) (transport.Subscription, error) {
	if _, _, err := d.live(); err != nil {
		return nil, err
	}
	role := d.roleOf(channel)
	s := &subscription{
		d: d, channel: channel, role: role, handler: handler, prefetch: max(opts.Prefetch, 1),
		manual: role == "queue" && opts.Group != "" && opts.AckMode != transport.AckAuto, held: map[*amqp.Message]struct{}{},
	}
	if err := d.attach(ctx, s); err != nil {
		return nil, err
	}
	d.mu.Lock()
	d.subs[s] = struct{}{}
	d.mu.Unlock()
	return s, nil
}

// attach opens the subscription's receiver and starts its receive loop (again after a reconnect).
func (d *Driver) attach(ctx context.Context, s *subscription) error {
	session, _, err := d.live()
	if err != nil {
		return err
	}
	openCtx, cancel := context.WithTimeout(ctx, linkTimeout)
	defer cancel()
	recv, err := session.NewReceiver(openCtx, s.channel, &amqp.ReceiverOptions{SourceCapabilities: []string{s.role}, Credit: int32(s.prefetch), SourceExpiryPolicy: amqp.ExpiryPolicyLinkDetach})
	if err != nil {
		return fmt.Errorf("amqp1: open receiver on %s: %w", s.channel, err)
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		_ = recv.Close(ctx)
		return nil
	}
	s.recv = recv
	s.mu.Unlock()
	go s.loop(recv)
	return nil
}

// Stats implements transport.StatsReporter through the management address.
func (d *Driver) Stats(ctx context.Context, channel string) (transport.ChannelStats, error) {
	if d.roleOf(channel) == "topic" {
		return transport.ChannelStats{}, nil
	}
	consumers, err := d.attribute(ctx, "queue."+channel, "ConsumerCount")
	if err != nil {
		return transport.ChannelStats{}, err
	}
	depth, err := d.attribute(ctx, "queue."+channel, "MessageCount")
	if err != nil {
		return transport.ChannelStats{}, err
	}
	return transport.ChannelStats{Depth: transport.Int(depth), Consumers: transport.Int(consumers)}, nil
}

// manage sends one management request and returns the reply's body with whether the operation succeeded.
func (d *Driver) manage(ctx context.Context, properties map[string]any, args []any) ([]byte, bool, error) {
	_, replyAddr, err := d.live()
	if err != nil {
		return nil, false, err
	}
	key := newHex(8)
	body, _ := json.Marshal(args)
	msg := &amqp.Message{Value: string(body), ApplicationProperties: properties, Properties: &amqp.MessageProperties{ReplyTo: &replyAddr, CorrelationID: key}}
	wait := make(chan *amqp.Message, 1)
	d.mu.Lock()
	d.pending[key] = wait
	d.mu.Unlock()
	forget := func() {
		d.mu.Lock()
		delete(d.pending, key)
		d.mu.Unlock()
	}
	if err := d.send(ctx, ManagementAddress, "", msg); err != nil {
		forget()
		return nil, false, err
	}
	timer := time.NewTimer(managementTimeout)
	defer timer.Stop()
	select {
	case reply, ok := <-wait:
		if !ok || reply == nil {
			return nil, false, errors.New("amqp1: connection lost during a management request")
		}
		succeeded, _ := reply.ApplicationProperties["_AMQ_OperationSucceeded"].(bool)
		return wireEvent(reply).Body, succeeded, nil
	case <-timer.C:
		forget()
		return nil, false, errors.New("amqp1: the management request timed out")
	case <-ctx.Done():
		forget()
		return nil, false, ctx.Err()
	}
}

// attribute reads one numeric attribute of a management resource; 0 when the resource does not exist.
func (d *Driver) attribute(ctx context.Context, resource, attribute string) (int, error) {
	raw, ok, err := d.manage(ctx, map[string]any{"_AMQ_ResourceName": resource, "_AMQ_Attribute": attribute}, []any{})
	if err != nil || !ok {
		return 0, err
	}
	var values []any
	if json.Unmarshal(raw, &values) != nil || len(values) == 0 {
		return 0, nil
	}
	if n, ok := values[0].(float64); ok {
		return int(n), nil
	}
	return 0, nil
}

// DeleteChannels removes the queues and addresses of channels through the management address (tests and operators).
func (d *Driver) DeleteChannels(ctx context.Context, channels ...string) error {
	for _, name := range channels {
		if _, _, err := d.manage(ctx, map[string]any{"_AMQ_ResourceName": "broker", "_AMQ_OperationName": "destroyQueue"}, []any{name, true, true}); err != nil {
			return err
		}
		if _, _, err := d.manage(ctx, map[string]any{"_AMQ_ResourceName": "broker", "_AMQ_OperationName": "deleteAddress"}, []any{name, true}); err != nil {
			return err
		}
	}
	return nil
}

// Names lists the broker's queue or address names (`QueueNames` / `AddressNames`), for test cleanup.
func (d *Driver) Names(ctx context.Context, attribute string) ([]string, error) {
	raw, ok, err := d.manage(ctx, map[string]any{"_AMQ_ResourceName": "broker", "_AMQ_Attribute": attribute}, []any{})
	if err != nil || !ok {
		return nil, err
	}
	var values [][]string
	if json.Unmarshal(raw, &values) != nil || len(values) == 0 {
		return nil, nil
	}
	return values[0], nil
}

// Close implements transport.Driver.
func (d *Driver) Close() error {
	d.mu.Lock()
	if d.state == "closed" {
		d.mu.Unlock()
		return nil
	}
	d.state = "closed"
	conn := d.conn
	subs := make([]*subscription, 0, len(d.subs))
	for s := range d.subs {
		subs = append(subs, s)
	}
	d.subs = map[*subscription]struct{}{}
	pending := d.pending
	d.pending = map[string]chan *amqp.Message{}
	d.mu.Unlock()
	for _, w := range pending {
		close(w)
	}
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
	d        *Driver
	channel  string
	role     string
	handler  transport.Handler
	prefetch int
	manual   bool

	mu     sync.Mutex
	recv   *amqp.Receiver
	held   map[*amqp.Message]struct{}
	closed bool
}

func (s *subscription) Channel() string { return s.channel }

// loop receives until the link ends; the credit window (prefetch) bounds unsettled deliveries.
func (s *subscription) loop(recv *amqp.Receiver) {
	ctx := context.Background()
	for {
		msg, err := recv.Receive(ctx, nil)
		if err != nil {
			return
		}
		s.mu.Lock()
		if s.closed || s.recv != recv {
			s.mu.Unlock()
			_ = recv.ModifyMessage(ctx, msg, &amqp.ModifyMessageOptions{DeliveryFailed: true})
			continue
		}
		if s.manual {
			s.held[msg] = struct{}{}
		}
		s.mu.Unlock()
		del := &delivery{s: s, recv: recv, msg: msg}
		if !s.manual {
			del.settled.Store(true)
			_ = recv.AcceptMessage(ctx, msg)
		}
		go s.handler(ctx, wireEvent(msg), del)
	}
}

// detach forgets the receiver after a connection loss (the broker requeues what was unsettled).
func (s *subscription) detach() {
	s.mu.Lock()
	s.recv = nil
	s.held = map[*amqp.Message]struct{}{}
	s.mu.Unlock()
}

// Close settles what it holds as failed deliveries (so the broker redelivers with delivery-count + 1) and detaches.
func (s *subscription) Close(ctx context.Context) error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	recv := s.recv
	held := make([]*amqp.Message, 0, len(s.held))
	for m := range s.held {
		held = append(held, m)
	}
	s.held = map[*amqp.Message]struct{}{}
	s.recv = nil
	s.mu.Unlock()
	s.d.mu.Lock()
	delete(s.d.subs, s)
	s.d.mu.Unlock()
	if recv == nil {
		return nil
	}
	for _, m := range held {
		_ = recv.ModifyMessage(ctx, m, &amqp.ModifyMessageOptions{DeliveryFailed: true})
	}
	err := recv.Close(ctx)
	var linkErr *amqp.LinkError
	var connErr *amqp.ConnError
	if err != nil && !errors.As(err, &linkErr) && !errors.As(err, &connErr) {
		return err
	}
	return nil
}

type delivery struct {
	s       *subscription
	recv    *amqp.Receiver
	msg     *amqp.Message
	settled atomic.Bool
}

// Attempt: delivery-count counts prior failed deliveries (0 on the first).
func (d *delivery) Attempt() int {
	if d.msg.Header != nil && d.msg.Header.DeliveryCount > 0 {
		return int(d.msg.Header.DeliveryCount) + 1
	}
	return 1
}

func (d *delivery) settle() bool {
	if !d.settled.CompareAndSwap(false, true) {
		return false
	}
	d.s.mu.Lock()
	delete(d.s.held, d.msg)
	d.s.mu.Unlock()
	return true
}

func (d *delivery) Ack(ctx context.Context) error {
	if !d.settle() {
		return nil
	}
	if err := d.recv.AcceptMessage(ctx, d.msg); err != nil && !isLinkGone(err) {
		return fmt.Errorf("amqp1: accept: %w", err)
	}
	return nil
}

// Nack: requeue is modified{delivery-failed} (redelivered, delivery-count + 1); otherwise the message is dropped (accepted).
func (d *delivery) Nack(ctx context.Context, requeue bool) error {
	if !d.settle() {
		return nil
	}
	var err error
	if requeue {
		err = d.recv.ModifyMessage(ctx, d.msg, &amqp.ModifyMessageOptions{DeliveryFailed: true})
	} else {
		err = d.recv.AcceptMessage(ctx, d.msg)
	}
	if err != nil && !isLinkGone(err) {
		return fmt.Errorf("amqp1: nack: %w", err)
	}
	return nil
}

// Reply implements transport.Replier: the response goes to the request's reply-to with its correlation id.
func (d *delivery) Reply(ctx context.Context, event transport.WireEvent) error {
	if d.msg.Properties == nil || d.msg.Properties.ReplyTo == nil || *d.msg.Properties.ReplyTo == "" {
		return errors.New("amqp1: the request carries no reply-to address")
	}
	out := message(event, false, 0, "")
	out.Properties.CorrelationID = d.msg.Properties.CorrelationID
	return d.s.d.send(ctx, *d.msg.Properties.ReplyTo, "", out)
}

func isLinkGone(err error) bool {
	var linkErr *amqp.LinkError
	var connErr *amqp.ConnError
	return errors.As(err, &linkErr) || errors.As(err, &connErr)
}

var (
	_ transport.Driver        = (*Driver)(nil)
	_ transport.Requester     = (*Driver)(nil)
	_ transport.StatsReporter = (*Driver)(nil)
	_ transport.Replier       = (*delivery)(nil)
)
