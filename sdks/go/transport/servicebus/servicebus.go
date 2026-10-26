// Package servicebus is the Azure Service Bus driver of sdks/go/transport
// (docs/transports.md "Brokers", docs/protocol.md §14.9), built on
// github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus. It is
// wire-compatible with the TypeScript driver (@landflow/transports/servicebus)
// and works against the Service Bus emulator (UseDevelopmentEmulator=true) and
// a real namespace.
//
// Service Bus has no exclusive consumers, no broadcast queues and, on the
// emulator, no entity creation at runtime, so the channel roles land on
// pre-declared entities:
//   - Request channels: a queue named after the channel (Config.QueueFor maps
//     it), peek-lock, competing receivers pulling up to prefetch messages.
//     Ack completes, Nack(requeue) abandons (DeliveryCount counts it),
//     Nack(drop) completes; held messages have their locks renewed; a closing
//     subscription abandons what it holds.
//   - Instance and reply channels: one session-enabled queue each
//     (<prefix>.v1.instance, <prefix>.v1.reply), session id = channel name;
//     the consumer accepts its session (one receiver per session) and renews
//     the session lock while it lives.
//   - Broadcast channels (registry, control): one topic (<prefix>.v1.broadcast)
//     with a pool of session-enabled subscriptions bc-00…; every broadcast
//     message carries the session id "broadcast" and the channel in the
//     `lfchannel` application property; a consumer claims a subscription by
//     locking that session on it, drains what accumulated while unclaimed,
//     then receives (receive-and-delete) its channel's events.
//   - CloudEvents binary mode: application properties under `ce_`, content type
//     as the message's ContentType; per-message TimeToLive; replies through the
//     reply channel; undeliverable unknown (no receiver counts); Stats peeks an
//     approximate depth.
//
// Entities: a real namespace gets them created by Declare through the administration
// client (CreateEntities, on by default outside the emulator; the key needs Manage
// rights). The emulator's are fixed in deploy/infra/servicebus/Config.json, written by
// deploy/scripts/servicebus-config.py (the bundled plugins plus any ids you pass); only the
// per-plugin request queues vary. A missing one fails Declare naming the entity and the script.
//
// This package is its own Go module so sdks/go stays free of the Azure SDK.
// Code use: servicebus.New(servicebus.Config{ConnectionString: "Endpoint=sb://…"});
// env use: blank-import the package and set LANDFLOW_SERVICEBUS_URL (a
// connection string or sb://host:port with LANDFLOW_SERVICEBUS_USERNAME /
// _PASSWORD as the key name and key; _EMULATOR=true; _CREATEENTITIES=true|false; _PREFIX; _MAXMESSAGEBYTES).
package servicebus

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus"
	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus/admin"

	"github.com/landflow/landflow/sdks/go/transport"
)

// Kind is the transport kind this driver registers.
const Kind = "servicebus"

// HeaderPrefix is the prefix of CloudEvents attributes on application properties (as the TS driver writes them).
const HeaderPrefix = "ce_"

// ChannelProperty is the driver-private application property naming the channel.
const ChannelProperty = "lfchannel"

// BroadcastSession is the session id every broadcast message carries; consumers claim a subscription by locking it.
const BroadcastSession = "broadcast"

// DefaultMaxMessageBytes leaves room under the Standard tier's (and the emulator's) 256 KiB AMQP message limit.
const DefaultMaxMessageBytes = 240 * 1024

// DefaultMaxHeaderBytes is Service Bus's cap on a message's application properties.
const DefaultMaxHeaderBytes = 64 * 1024

// DefaultBroadcastSubscriptions is the size of the broadcast subscription pool.
const DefaultBroadcastSubscriptions = 16

const (
	lockRenewEvery = 20 * time.Second
	drainWait      = 150 * time.Millisecond
	// receiveWait keeps credit standing on the link: the emulator does not hand a message abandoned by another receiver
	// to a link that only adds credit later (it polls in windows), while a link with credit gets it at once.
	receiveWait = 30 * time.Second
	peekDepth   = 100
)

// Config configures a Service Bus driver.
type Config struct {
	transport.Config
	// ConnectionString is Endpoint=sb://…;SharedAccessKeyName=…;SharedAccessKey=…[;UseDevelopmentEmulator=true].
	ConnectionString string
	// Emulator marks the development emulator (fixed entities); default: UseDevelopmentEmulator=true in the connection string.
	Emulator bool
	// CreateEntities creates missing queues, topics and subscriptions through the administration client (default: not on the emulator).
	CreateEntities *bool
	// InstanceQueue, ReplyQueue and BroadcastTopic name the shared entities (defaults <prefix>.v1.instance, .reply, .broadcast).
	InstanceQueue, ReplyQueue, BroadcastTopic string
	// BroadcastSubscriptions names the pool (default bc-00 … bc-15).
	BroadcastSubscriptions []string
	// QueueFor maps a request channel onto its queue (default: the channel name).
	QueueFor func(channel string) string
	// MaxMessageBytes the driver accepts (default 240 KiB).
	MaxMessageBytes int
	// MaxOpsPerSecond paces publishes and settlements (default: 40 on the emulator, whose namespace throttles above about 100
	// operations a second; unlimited on a real namespace; zero or negative disables). nil means the default.
	MaxOpsPerSecond *int
}

// Driver is a Service Bus connection: one client, a sender per entity and a receiver per subscription.
type Driver struct {
	cfg  Config
	caps transport.Capabilities

	mu       sync.Mutex
	client   *azservicebus.Client
	admin    *admin.Client
	senders  map[string]*azservicebus.Sender
	peekers  map[string]*azservicebus.Receiver
	settlers map[string]*azservicebus.Receiver // one per queue: settles deliveries of a closed receiver link
	declared map[string]transport.ChannelSpec
	subs     map[*subscription]struct{}
	closed   bool
	gate     *rateGate
}

var emulatorRE = regexp.MustCompile(`(?i)(^|;)\s*UseDevelopmentEmulator\s*=\s*true\s*(;|$)`)

// IsEmulatorConnectionString reports UseDevelopmentEmulator=true.
func IsEmulatorConnectionString(cs string) bool { return emulatorRE.MatchString(cs) }

// New returns an unconnected driver; defaults are filled in.
func New(cfg Config) *Driver {
	if cfg.Prefix == "" {
		cfg.Prefix = transport.DefaultPrefix
	}
	if !cfg.Emulator && IsEmulatorConnectionString(cfg.ConnectionString) {
		cfg.Emulator = true
	}
	if cfg.CreateEntities == nil {
		create := !cfg.Emulator
		cfg.CreateEntities = &create
	}
	base := cfg.Prefix + ".v1"
	if cfg.InstanceQueue == "" {
		cfg.InstanceQueue = base + ".instance"
	}
	if cfg.ReplyQueue == "" {
		cfg.ReplyQueue = base + ".reply"
	}
	if cfg.BroadcastTopic == "" {
		cfg.BroadcastTopic = base + ".broadcast"
	}
	if len(cfg.BroadcastSubscriptions) == 0 {
		for i := 0; i < DefaultBroadcastSubscriptions; i++ {
			cfg.BroadcastSubscriptions = append(cfg.BroadcastSubscriptions, fmt.Sprintf("bc-%02d", i))
		}
	}
	if cfg.MaxMessageBytes <= 0 {
		cfg.MaxMessageBytes = DefaultMaxMessageBytes
	}
	ops, perKiB := 0, 0.0
	if cfg.Emulator {
		perKiB = EmulatorMsPerKiB
	}
	if cfg.MaxOpsPerSecond != nil {
		ops = *cfg.MaxOpsPerSecond
	} else if cfg.Emulator {
		ops = EmulatorOpsPerSecond
	}
	return &Driver{
		cfg:  cfg,
		gate: newRateGate(ops, 16, perKiB),
		caps: transport.Capabilities{
			Replies:         transport.RepliesChannel,
			WorkSharing:     true,
			Buffering:       true,
			TTL:             true,
			Undeliverable:   transport.UndeliverableUnknown,
			Persistence:     transport.PersistenceDisk,
			MaxMessageBytes: cfg.MaxMessageBytes,
			Latency:         transport.LatencyMedium,
			Headers:         true,
			MaxHeaderBytes:  DefaultMaxHeaderBytes,
			OrderingKeys:    false,
			Nack:            true,
			Attempts:        true,
		},
		senders:  map[string]*azservicebus.Sender{},
		peekers:  map[string]*azservicebus.Receiver{},
		settlers: map[string]*azservicebus.Receiver{},
		declared: map[string]transport.ChannelSpec{},
		subs:     map[*subscription]struct{}{},
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
	endpointRE  = regexp.MustCompile(`(?i)^(?:sb|servicebus)://([^/?#@]+)/?$`)
	loopbackRE  = regexp.MustCompile(`(?i)^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$`)
	hasKeyRE    = regexp.MustCompile(`(?i)SharedAccessKey=[^;]+`)
	hasSigRE    = regexp.MustCompile(`(?i)SharedAccessSignature=`)
	sbEndpoint  = regexp.MustCompile(`(?i)(^|;)\s*Endpoint=sb://[^;]+`)
	connStartRE = regexp.MustCompile(`(?i)^Endpoint=`)
)

// ConfigFromURL builds a Config from a connection string (Endpoint=sb://…;…) or
// an sb://host endpoint with the key name as the username and the key as the
// password; fields: emulator (true), createentities (true/false; default on outside the emulator), maxmessagebytes.
func ConfigFromURL(connectionID, rawURL string, opts transport.ConnectionOptions) (Config, error) {
	raw := strings.TrimSpace(rawURL)
	if raw == "" {
		return Config{}, errors.New("servicebus: the URL is empty (want a connection string Endpoint=sb://…;SharedAccessKeyName=…;SharedAccessKey=… or an sb:// endpoint)")
	}
	emulatorField := strings.EqualFold(strings.TrimSpace(opts.Fields["emulator"]), "true")
	var cs string
	if connStartRE.MatchString(raw) {
		if !sbEndpoint.MatchString(raw) {
			return Config{}, errors.New("servicebus: the connection string's Endpoint must be an sb:// URL")
		}
		var parts []string
		for _, p := range strings.Split(raw, ";") {
			if p = strings.TrimSpace(p); p != "" {
				parts = append(parts, p)
			}
		}
		if opts.Username != "" {
			parts = append(parts, "SharedAccessKeyName="+opts.Username)
		}
		if opts.Password != "" {
			parts = append(parts, "SharedAccessKey="+opts.Password)
		}
		if emulatorField && !IsEmulatorConnectionString(raw) {
			parts = append(parts, "UseDevelopmentEmulator=true")
		}
		cs = strings.Join(parts, ";") + ";"
	} else {
		m := endpointRE.FindStringSubmatch(raw)
		if m == nil {
			return Config{}, fmt.Errorf("servicebus: %q is not a Service Bus connection string or sb://host endpoint", rawURL)
		}
		emulator := emulatorField || loopbackRE.MatchString(m[1])
		if !emulator && (opts.Username == "" || opts.Password == "") {
			return Config{}, errors.New("servicebus: the shared access key name (username) and key (password) are needed, or a full connection string")
		}
		name, key := opts.Username, opts.Password
		if name == "" {
			name = "RootManageSharedAccessKey"
		}
		if key == "" {
			key = "SAS_KEY_VALUE"
		}
		cs = "Endpoint=sb://" + m[1] + ";SharedAccessKeyName=" + name + ";SharedAccessKey=" + key + ";"
		if emulator {
			cs += "UseDevelopmentEmulator=true;"
		}
	}
	emulator := emulatorField || IsEmulatorConnectionString(cs)
	if !emulator && !hasKeyRE.MatchString(cs) && !hasSigRE.MatchString(cs) {
		return Config{}, errors.New("servicebus: the connection string has no SharedAccessKey (put it in the password)")
	}
	cfg := Config{Config: transport.Config{ConnectionID: connectionID, Prefix: opts.Prefix}, ConnectionString: cs, Emulator: emulator}
	if v := opts.Fields["maxmessagebytes"]; v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			return Config{}, fmt.Errorf("servicebus: maxmessagebytes %q must be a positive integer", v)
		}
		cfg.MaxMessageBytes = n
	}
	if v := opts.Fields["maxopspersecond"]; v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return Config{}, fmt.Errorf("servicebus: maxopspersecond %q must be an integer (0 disables)", v)
		}
		cfg.MaxOpsPerSecond = &n
	}
	switch strings.ToLower(strings.TrimSpace(opts.Fields["createentities"])) {
	case "true":
		on := true
		cfg.CreateEntities = &on
	case "false":
		off := false
		cfg.CreateEntities = &off
	}
	return cfg, nil
}

// Kind implements transport.Driver.
func (d *Driver) Kind() string { return Kind }

// Capabilities implements transport.Driver.
func (d *Driver) Capabilities() transport.Capabilities { return d.caps }

// Config implements transport.Driver.
func (d *Driver) Config() transport.Config { return d.cfg.Config }

// ServiceBusConfig returns the full driver configuration.
func (d *Driver) ServiceBusConfig() Config { return d.cfg }

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

// EntityKind says what a channel maps onto.
type EntityKind string

const (
	EntityQueue   EntityKind = "queue"
	EntitySession EntityKind = "session"
	EntityTopic   EntityKind = "topic"
)

// Entity is where a channel lives: a plain queue, a session of a session-enabled queue, or the broadcast topic.
type Entity struct {
	Kind    EntityKind
	Name    string
	Session string
}

type role string

const (
	roleRequest   role = "request"
	roleInstance  role = "instance"
	roleReply     role = "reply"
	roleBroadcast role = "broadcast"
)

// InferRole reads the role of an undeclared channel from its name (<prefix>.v1.<role>…), request otherwise.
func inferRole(name string) role {
	parts := strings.Split(name, ".")
	if len(parts) > 2 {
		switch parts[2] {
		case "instance":
			return roleInstance
		case "reply":
			return roleReply
		case "registry", "control":
			return roleBroadcast
		}
	}
	return roleRequest
}

// roleOf is the entity role of a declared channel: the spec's role first (a
// reply channel is broadcast-delivery but one host's session), then its delivery.
func roleOf(spec transport.ChannelSpec) role {
	switch {
	case spec.Role == transport.RoleReply:
		return roleReply
	case spec.Role == transport.RoleInstance:
		return roleInstance
	case spec.Role == transport.RoleRegistry, spec.Role == transport.RoleControl, spec.Delivery == transport.DeliveryBroadcast:
		return roleBroadcast
	case spec.Durable:
		return roleRequest
	default:
		return roleInstance
	}
}

// EntityOf maps a channel onto its entity.
func (d *Driver) EntityOf(channel string) Entity {
	d.mu.Lock()
	spec, ok := d.declared[channel]
	d.mu.Unlock()
	r := inferRole(channel)
	if ok {
		r = roleOf(spec)
	}
	return d.entityFor(channel, r)
}

func (d *Driver) entityFor(channel string, r role) Entity {
	switch r {
	case roleInstance:
		return Entity{Kind: EntitySession, Name: d.cfg.InstanceQueue, Session: channel}
	case roleReply:
		return Entity{Kind: EntitySession, Name: d.cfg.ReplyQueue, Session: channel}
	case roleBroadcast:
		return Entity{Kind: EntityTopic, Name: d.cfg.BroadcastTopic}
	default:
		name := channel
		if d.cfg.QueueFor != nil {
			name = d.cfg.QueueFor(channel)
		}
		return Entity{Kind: EntityQueue, Name: name}
	}
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

func redact(cs string) string { return hasKeyRE.ReplaceAllString(cs, "SharedAccessKey=***") }

func entityMissing(err error) bool {
	var sbErr *azservicebus.Error
	return errors.As(err, &sbErr) && sbErr.Code == azservicebus.CodeNotFound || strings.Contains(err.Error(), "could not be found")
}

func sessionLocked(err error) bool {
	return strings.Contains(err.Error(), "session-cannot-be-locked") || strings.Contains(err.Error(), "SessionCannotBeLocked")
}

// Connect implements transport.Driver: it creates the client and opens a
// sender link on the broadcast topic, so an unreachable namespace fails here.
func (d *Driver) Connect(ctx context.Context) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return fmt.Errorf("servicebus: driver closed: %w", transport.ErrNotConnected)
	}
	if d.client != nil {
		return nil
	}
	if d.cfg.ConnectionString == "" {
		return errors.New("servicebus: no connection string configured")
	}
	// The library's default retry waits 4 s, 8 s, ... between attempts: far longer than a throttle episode needs. Short delays here
	// (link recovery stays in the library); withBackoff (retry.go) covers what still gets through.
	client, err := azservicebus.NewClientFromConnectionString(d.cfg.ConnectionString, &azservicebus.ClientOptions{
		RetryOptions: azservicebus.RetryOptions{MaxRetries: 3, RetryDelay: 200 * time.Millisecond, MaxRetryDelay: 2 * time.Second},
	})
	if err != nil {
		return fmt.Errorf("servicebus: %w", err)
	}
	sender, err := client.NewSender(d.cfg.BroadcastTopic, nil)
	if err == nil {
		var batch *azservicebus.MessageBatch
		err = withBackoff(ctx, func() (e error) { batch, e = sender.NewMessageBatch(ctx, nil); return e })
		if err == nil && batch.NumBytes() == 0 {
			// Learn the link's maximum message size: the Standard tier and the emulator advertise 256 KiB.
			if maxBytes := batchMaxBytes(batch); maxBytes > 0 && maxBytes-16*1024 < d.caps.MaxMessageBytes {
				d.caps.MaxMessageBytes = max(64*1024, maxBytes-16*1024)
			}
		}
	}
	if err != nil {
		_ = client.Close(ctx)
		return fmt.Errorf("servicebus: cannot connect to %s: %w", redact(d.cfg.ConnectionString), err)
	}
	d.client = client
	d.senders[d.cfg.BroadcastTopic] = sender
	if *d.cfg.CreateEntities {
		if d.admin, err = admin.NewClientFromConnectionString(d.cfg.ConnectionString, nil); err != nil {
			_ = client.Close(ctx)
			d.client = nil
			return fmt.Errorf("servicebus: administration client: %w", err)
		}
	}
	return nil
}

// batchMaxBytes is the link's advertised maximum (NumBytes is 0 on an empty batch; the SDK keeps the max private).
func batchMaxBytes(*azservicebus.MessageBatch) int { return 0 }

func (d *Driver) connected() (*azservicebus.Client, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.client == nil || d.closed {
		return nil, fmt.Errorf("servicebus: %w", transport.ErrNotConnected)
	}
	return d.client, nil
}

func (d *Driver) senderFor(name string) (*azservicebus.Sender, error) {
	d.mu.Lock()
	client := d.client
	s, ok := d.senders[name]
	d.mu.Unlock()
	if client == nil {
		return nil, fmt.Errorf("servicebus: %w", transport.ErrNotConnected)
	}
	if ok {
		return s, nil
	}
	s, err := client.NewSender(name, nil)
	if err != nil {
		return nil, err
	}
	d.mu.Lock()
	if existing, ok := d.senders[name]; ok {
		d.mu.Unlock()
		_ = s.Close(context.Background())
		return existing, nil
	}
	d.senders[name] = s
	d.mu.Unlock()
	return s, nil
}

// settlerFor is a receiver on the queue that never receives: a delivery whose own link is closed is settled through
// it (the SDK then uses the management link with the lock token).
func (d *Driver) settlerFor(queue string) (*azservicebus.Receiver, error) {
	d.mu.Lock()
	client := d.client
	r, ok := d.settlers[queue]
	d.mu.Unlock()
	if client == nil {
		return nil, fmt.Errorf("servicebus: %w", transport.ErrNotConnected)
	}
	if ok {
		return r, nil
	}
	r, err := client.NewReceiverForQueue(queue, &azservicebus.ReceiverOptions{ReceiveMode: azservicebus.ReceiveModePeekLock})
	if err != nil {
		return nil, err
	}
	d.mu.Lock()
	if existing, ok := d.settlers[queue]; ok {
		d.mu.Unlock()
		_ = r.Close(context.Background())
		return existing, nil
	}
	d.settlers[queue] = r
	d.mu.Unlock()
	return r, nil
}

// Declare implements transport.Driver: creates entities when CreateEntities
// and verifies they exist (a sender link on a missing one fails readably).
func (d *Driver) Declare(ctx context.Context, channels []transport.ChannelSpec) error {
	if _, err := d.connected(); err != nil {
		return err
	}
	for _, spec := range channels {
		d.mu.Lock()
		_, done := d.declared[spec.Name]
		d.mu.Unlock()
		if done {
			continue
		}
		entity := d.entityFor(spec.Name, roleOf(spec))
		if d.admin != nil {
			if err := d.createEntity(ctx, entity, spec); err != nil {
				return adminError(entity, err)
			}
		}
		if err := d.verify(ctx, entity); err != nil {
			return err
		}
		d.mu.Lock()
		d.declared[spec.Name] = spec
		d.mu.Unlock()
	}
	return nil
}

func (d *Driver) createEntity(ctx context.Context, entity Entity, spec transport.ChannelSpec) error {
	str := func(s string) *string { return &s }
	i32 := func(n int32) *int32 { return &n }
	b := func(v bool) *bool { return &v }
	ttl := "P1D"
	if spec.TTL > 0 {
		ttl = isoDuration(spec.TTL)
	}
	switch entity.Kind {
	case EntityQueue:
		if _, err := d.admin.GetQueue(ctx, entity.Name, nil); err == nil {
			return nil
		}
		_, err := d.admin.CreateQueue(ctx, entity.Name, &admin.CreateQueueOptions{Properties: &admin.QueueProperties{LockDuration: str("PT1M"), MaxDeliveryCount: i32(10), DefaultMessageTimeToLive: str(ttl)}})
		return err
	case EntitySession:
		if _, err := d.admin.GetQueue(ctx, entity.Name, nil); err == nil {
			return nil
		}
		_, err := d.admin.CreateQueue(ctx, entity.Name, &admin.CreateQueueOptions{Properties: &admin.QueueProperties{RequiresSession: b(true), LockDuration: str("PT1M"), MaxDeliveryCount: i32(10), DefaultMessageTimeToLive: str("PT5M")}})
		return err
	default:
		if _, err := d.admin.GetTopic(ctx, entity.Name, nil); err != nil {
			if _, err := d.admin.CreateTopic(ctx, entity.Name, &admin.CreateTopicOptions{Properties: &admin.TopicProperties{DefaultMessageTimeToLive: str("PT5M")}}); err != nil {
				return err
			}
		}
		for _, name := range d.cfg.BroadcastSubscriptions {
			if _, err := d.admin.GetSubscription(ctx, entity.Name, name, nil); err == nil {
				continue
			}
			if _, err := d.admin.CreateSubscription(ctx, entity.Name, name, &admin.CreateSubscriptionOptions{Properties: &admin.SubscriptionProperties{RequiresSession: b(true), LockDuration: str("PT1M"), MaxDeliveryCount: i32(10), DefaultMessageTimeToLive: str("PT1M")}}); err != nil {
				return err
			}
		}
		return nil
	}
}

func isoDuration(d time.Duration) string {
	secs := int64(d / time.Second)
	if d%time.Second != 0 {
		secs++
	}
	return fmt.Sprintf("PT%dS", max(secs, 1))
}

// missingHint says what to do about a missing entity: the emulator's entities come from deploy/scripts/servicebus-config.py, a real
// namespace's from CreateEntities. queue is the missing queue's name ("" for a topic or subscription).
func missingHint(emulator bool, queue string) string {
	if !emulator {
		return "create it, or turn on CreateEntities with a key that has Manage rights"
	}
	arg := ""
	if queue != "" {
		if _, id, ok := strings.Cut(queue, ".v1.plugin."); ok {
			arg = " --plugin " + id
		} else {
			arg = " --queue " + queue
		}
	}
	return "the emulator has no management API: run deploy/scripts/servicebus-config.py" + arg + ", then recreate the emulator (docs: deploy/README.md \"Service Bus entities\")"
}

// adminError names the entity when an administration call is refused for lack of the Manage right.
func adminError(entity Entity, err error) error {
	msg := err.Error()
	if strings.Contains(msg, "401") || strings.Contains(msg, "403") || strings.Contains(msg, "Unauthorized") || strings.Contains(msg, "Forbidden") {
		return fmt.Errorf("servicebus: cannot create %s %q: the connection string has no Manage right (create the entity yourself, or turn CreateEntities off): %w", entity.Kind, entity.Name, err)
	}
	return fmt.Errorf("servicebus: create %s %q: %w", entity.Kind, entity.Name, err)
}

func (d *Driver) verify(ctx context.Context, entity Entity) error {
	d.mu.Lock()
	_, known := d.senders[entity.Name]
	d.mu.Unlock()
	if known {
		return nil
	}
	sender, err := d.senderFor(entity.Name)
	if err == nil {
		err = withBackoff(ctx, func() error { _, e := sender.NewMessageBatch(ctx, nil); return e })
	}
	if err != nil {
		d.mu.Lock()
		delete(d.senders, entity.Name)
		d.mu.Unlock()
		if sender != nil {
			_ = sender.Close(context.Background())
		}
		if entityMissing(err) {
			kind, queue := "queue", entity.Name
			if entity.Kind == EntityTopic {
				kind, queue = "topic", ""
			}
			return fmt.Errorf("servicebus: %s %q does not exist (%s)", kind, entity.Name, missingHint(d.cfg.Emulator, queue))
		}
		return fmt.Errorf("servicebus: verify %q: %w", entity.Name, err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

// Publish implements transport.Driver.
func (d *Driver) Publish(ctx context.Context, channel string, event transport.WireEvent, opts transport.PublishOptions) (transport.PublishOutcome, error) {
	if _, err := d.connected(); err != nil {
		return "", err
	}
	d.mu.Lock()
	spec, declared := d.declared[channel]
	d.mu.Unlock()
	entity := d.EntityOf(channel)
	msg := &azservicebus.Message{Body: event.Body, ApplicationProperties: map[string]any{}}
	for name, value := range transport.PrefixHeaders(event.Headers, HeaderPrefix) {
		if name == "content-type" {
			ct := value
			msg.ContentType = &ct
			continue
		}
		msg.ApplicationProperties[name] = value
	}
	msg.ApplicationProperties[ChannelProperty] = channel
	switch entity.Kind {
	case EntitySession:
		s := entity.Session
		msg.SessionID = &s
	case EntityTopic:
		s := BroadcastSession
		msg.SessionID = &s
	}
	ttl := opts.TTL
	if ttl <= 0 && declared {
		ttl = spec.TTL
	}
	if ttl > 0 {
		t := max(ttl, time.Millisecond)
		msg.TimeToLive = &t
	}
	sender, err := d.senderFor(entity.Name)
	if err != nil {
		return "", fmt.Errorf("servicebus: sender for %s: %w", channel, err)
	}
	if err := withBackoff(ctx, func() error {
		if err := d.gate.take(ctx, len(event.Body)); err != nil {
			return err
		}
		return sender.SendMessage(ctx, msg, nil)
	}); err != nil {
		return "", fmt.Errorf("servicebus: publish to %s (%s %s) failed: %w", channel, entity.Kind, entity.Name, describeError(err))
	}
	return transport.Accepted, nil
}

// ---------------------------------------------------------------------------
// Consume
// ---------------------------------------------------------------------------

// receiver is the common surface of azservicebus.Receiver and SessionReceiver.
type receiver interface {
	ReceiveMessages(ctx context.Context, maxMessages int, options *azservicebus.ReceiveMessagesOptions) ([]*azservicebus.ReceivedMessage, error)
	CompleteMessage(ctx context.Context, message *azservicebus.ReceivedMessage, options *azservicebus.CompleteMessageOptions) error
	AbandonMessage(ctx context.Context, message *azservicebus.ReceivedMessage, options *azservicebus.AbandonMessageOptions) error
	DeadLetterMessage(ctx context.Context, message *azservicebus.ReceivedMessage, options *azservicebus.DeadLetterOptions) error
	Close(ctx context.Context) error
}

// Consume implements transport.Driver.
func (d *Driver) Consume(ctx context.Context, channel string, opts transport.ConsumeOptions, handler transport.Handler) (transport.Subscription, error) {
	client, err := d.connected()
	if err != nil {
		return nil, err
	}
	entity := d.EntityOf(channel)
	manual := opts.AckMode != transport.AckAuto && entity.Kind != EntityTopic
	// Session receivers always peek-lock (the emulator delivers nothing to a receive-and-delete session receiver); auto
	// mode then completes on receipt.
	mode := azservicebus.ReceiveModeReceiveAndDelete
	if manual || entity.Kind == EntitySession {
		mode = azservicebus.ReceiveModePeekLock
	}
	s := &subscription{d: d, channel: channel, entity: entity, done: make(chan struct{}), handler: handler, manual: manual, peekLock: mode == azservicebus.ReceiveModePeekLock, prefetch: max(opts.Prefetch, 1), slots: make(chan struct{}, max(opts.Prefetch, 1)), held: map[*delivery]struct{}{}}
	switch entity.Kind {
	case EntityQueue:
		r, err := client.NewReceiverForQueue(entity.Name, &azservicebus.ReceiverOptions{ReceiveMode: mode})
		if err != nil {
			return nil, fmt.Errorf("servicebus: receiver on %s: %w", entity.Name, err)
		}
		s.queue = r
		s.recv = r
	case EntitySession:
		var r *azservicebus.SessionReceiver
		err := withBackoff(ctx, func() (e error) {
			r, e = client.AcceptSessionForQueue(ctx, entity.Name, entity.Session, &azservicebus.SessionReceiverOptions{ReceiveMode: mode})
			return e
		})
		if err != nil {
			if sessionLocked(err) {
				return nil, fmt.Errorf("servicebus: channel %s is already consumed by another process (session %s of %s is locked)", channel, entity.Session, entity.Name)
			}
			return nil, fmt.Errorf("servicebus: accept session %s on %s: %w", entity.Session, entity.Name, err)
		}
		s.session = r
		s.recv = r
	default:
		r, err := d.claimBroadcast(ctx, entity.Name)
		if err != nil {
			return nil, err
		}
		s.session = r
		s.recv = r
	}
	handlerCtx, cancelHandlers := context.WithCancel(context.Background())
	loopCtx, cancelLoop := context.WithCancel(handlerCtx)
	s.cancel, s.cancelLoop = cancelHandlers, cancelLoop
	d.mu.Lock()
	d.subs[s] = struct{}{}
	d.mu.Unlock()
	go s.run(loopCtx, handlerCtx)
	return s, nil
}

// claimBroadcast locks the broadcast session on the first free subscription of the pool and drains it.
func (d *Driver) claimBroadcast(ctx context.Context, topic string) (*azservicebus.SessionReceiver, error) {
	client, err := d.connected()
	if err != nil {
		return nil, err
	}
	var last error
	for _, name := range d.cfg.BroadcastSubscriptions {
		r, err := client.AcceptSessionForSubscription(ctx, topic, name, BroadcastSession, &azservicebus.SessionReceiverOptions{ReceiveMode: azservicebus.ReceiveModeReceiveAndDelete})
		if err != nil {
			last = err
			if sessionLocked(err) {
				continue
			}
			if entityMissing(err) {
				return nil, fmt.Errorf("servicebus: subscription %q of topic %q does not exist (%s)", name, topic, missingHint(d.cfg.Emulator, ""))
			}
			return nil, fmt.Errorf("servicebus: accept broadcast session on %s/%s: %w", topic, name, err)
		}
		// The emulator sometimes hands out a lock that is already stale: renewing validates (and extends) it.
		if err := r.RenewSessionLock(ctx, nil); err != nil {
			last = err
			_ = r.Close(ctx)
			continue
		}
		for {
			dctx, cancel := context.WithTimeout(ctx, drainWait)
			stale, err := r.ReceiveMessages(dctx, peekDepth, nil)
			cancel()
			if err != nil || len(stale) == 0 {
				break
			}
		}
		return r, nil
	}
	return nil, fmt.Errorf("servicebus: every broadcast subscription of %s is claimed (%d); add more: %v", topic, len(d.cfg.BroadcastSubscriptions), last)
}

// Stats implements transport.StatsReporter: an approximate depth (a peek) for request channels.
func (d *Driver) Stats(ctx context.Context, channel string) (transport.ChannelStats, error) {
	client, err := d.connected()
	if err != nil {
		return transport.ChannelStats{}, err
	}
	entity := d.EntityOf(channel)
	if entity.Kind != EntityQueue {
		return transport.ChannelStats{}, nil
	}
	d.mu.Lock()
	peeker, ok := d.peekers[entity.Name]
	d.mu.Unlock()
	if !ok {
		peeker, err = client.NewReceiverForQueue(entity.Name, &azservicebus.ReceiverOptions{ReceiveMode: azservicebus.ReceiveModePeekLock})
		if err != nil {
			return transport.ChannelStats{}, fmt.Errorf("servicebus: peek %s: %w", entity.Name, err)
		}
		d.mu.Lock()
		d.peekers[entity.Name] = peeker
		d.mu.Unlock()
	}
	var msgs []*azservicebus.ReceivedMessage
	err = withBackoff(ctx, func() (e error) { msgs, e = peeker.PeekMessages(ctx, peekDepth, nil); return e })
	if err != nil {
		return transport.ChannelStats{}, fmt.Errorf("servicebus: peek %s: %w", entity.Name, err)
	}
	depth := 0
	for _, m := range msgs {
		if ch, ok := m.ApplicationProperties[ChannelProperty]; !ok || ch == channel {
			depth++
		}
	}
	return transport.ChannelStats{Depth: transport.Int(depth)}, nil
}

// Close implements transport.Driver.
func (d *Driver) Close() error {
	d.mu.Lock()
	if d.closed {
		d.mu.Unlock()
		return nil
	}
	d.closed = true
	client := d.client
	d.admin = nil
	subs := make([]*subscription, 0, len(d.subs))
	for s := range d.subs {
		subs = append(subs, s)
	}
	d.subs = map[*subscription]struct{}{}
	senders, peekers := d.senders, d.peekers
	d.senders, d.peekers = map[string]*azservicebus.Sender{}, map[string]*azservicebus.Receiver{}
	d.declared = map[string]transport.ChannelSpec{}
	d.mu.Unlock()
	if client == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	for _, s := range subs {
		_ = s.Close(ctx) // may still open a settler on the client
	}
	for _, s := range senders {
		_ = s.Close(ctx)
	}
	for _, p := range peekers {
		_ = p.Close(ctx)
	}
	d.mu.Lock()
	settlers := d.settlers
	d.settlers = map[string]*azservicebus.Receiver{}
	d.client = nil
	d.mu.Unlock()
	for _, r := range settlers {
		_ = r.Close(ctx)
	}
	return client.Close(ctx)
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

type subscription struct {
	d          *Driver
	channel    string
	recv       receiver
	entity     Entity
	queue      *azservicebus.Receiver
	session    *azservicebus.SessionReceiver
	cancel     context.CancelFunc // the handlers' context
	cancelLoop context.CancelFunc // the receive loop's context (a child)
	done       chan struct{}
	handler    transport.Handler
	manual     bool
	peekLock   bool
	prefetch   int
	slots      chan struct{}
	closed     atomic.Bool
	closing    atomic.Bool // set before the held deliveries are abandoned on Close

	heldMu sync.Mutex
	held   map[*delivery]struct{}
}

func (s *subscription) Channel() string { return s.channel }

// run receives on ctx (the loop's) and hands deliveries to the handler with hctx (cancelled only after the held
// deliveries were abandoned on Close).
func (s *subscription) run(ctx context.Context, hctx context.Context) {
	defer close(s.done)
	if s.session != nil {
		// Keep the session lock (LockDuration, 1 min on the dev entities) for as long as the subscription lives.
		go func() {
			ticker := time.NewTicker(lockRenewEvery)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					rctx, cancel := context.WithTimeout(ctx, 10*time.Second)
					_ = s.session.RenewSessionLock(rctx, nil)
					cancel()
				}
			}
		}()
	}
	if s.manual && s.queue != nil {
		go s.renewLocks(ctx)
	}
	for ctx.Err() == nil {
		free := s.prefetch
		if s.manual {
			free = s.prefetch - len(s.slots)
			if free <= 0 {
				select {
				case <-ctx.Done():
					return
				case <-time.After(20 * time.Millisecond):
				}
				continue
			}
		}
		// One long receive at a time (it returns as soon as a message arrives), so the link's credit stands.
		rctx, cancel := context.WithTimeout(ctx, receiveWait)
		msgs, err := s.recv.ReceiveMessages(rctx, free, nil)
		cancel()
		if err != nil && ctx.Err() == nil && !errors.Is(err, context.DeadlineExceeded) {
			time.Sleep(100 * time.Millisecond)
		}
		for _, m := range msgs {
			if ctx.Err() != nil {
				if s.manual {
					_ = s.recv.AbandonMessage(context.Background(), m, nil)
				}
				continue
			}
			if ch, ok := m.ApplicationProperties[ChannelProperty]; ok && ch != s.channel {
				// Another channel's event on a shared entity: our own subscription (drop) or a mapped queue (keep it visible).
				if s.manual {
					reason := "wrong-channel"
					desc := fmt.Sprintf("%s received an event for %v", s.channel, ch)
					_ = s.recv.DeadLetterMessage(ctx, m, &azservicebus.DeadLetterOptions{Reason: &reason, ErrorDescription: &desc})
				}
				continue
			}
			del := &delivery{s: s, msg: m, attempt: max(int(m.DeliveryCount), 1)}
			if !s.manual {
				if s.session != nil && s.queue == nil && s.peekLock {
					_ = s.d.settleRetry(ctx, len(m.Body), func(c context.Context) error { return s.recv.CompleteMessage(c, m, nil) })
				}
				del.settled.Store(true)
				s.handler(hctx, toWire(m), del)
				continue
			}
			s.slots <- struct{}{}
			s.heldMu.Lock()
			if s.held != nil {
				s.held[del] = struct{}{}
			}
			s.heldMu.Unlock()
			go s.handler(hctx, toWire(m), del)
		}
	}
}

// renewLocks keeps the locks of held deliveries alive while their calls run.
func (s *subscription) renewLocks(ctx context.Context) {
	ticker := time.NewTicker(lockRenewEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.heldMu.Lock()
			held := make([]*delivery, 0, len(s.held))
			for del := range s.held {
				held = append(held, del)
			}
			s.heldMu.Unlock()
			for _, del := range held {
				rctx, cancel := context.WithTimeout(ctx, 10*time.Second)
				_ = s.queue.RenewMessageLock(rctx, del.msg, nil)
				cancel()
			}
		}
	}
}

// Close stops delivering. For a queue receiver the link is closed first and
// the held deliveries are then abandoned through the driver's settler receiver
// (the management link): the Go SDK leaves credit standing on a cancelled
// receive, and the emulator would hand an abandoned message back to that link
// (then keep it locked once the link closes) instead of to another consumer.
// Session receivers abandon through their own link before closing. The
// handlers' contexts are cancelled last, so the core's own settlement of a call
// it aborts on close cannot beat the hand-off.
func (s *subscription) Close(ctx context.Context) error {
	if !s.closed.CompareAndSwap(false, true) {
		return nil
	}
	s.cancelLoop()
	select {
	case <-s.done:
	case <-ctx.Done():
	}
	var closeErr error
	if s.queue != nil {
		closeErr = s.recv.Close(ctx)
		if settler, err := s.d.settlerFor(s.entity.Name); err == nil {
			s.abandonHeld(ctx, settler)
		} else {
			s.abandonHeld(ctx, nil)
		}
	} else {
		s.abandonHeld(ctx, s.recv)
		closeErr = s.recv.Close(ctx)
	}
	s.cancel()
	s.d.mu.Lock()
	delete(s.d.subs, s)
	s.d.mu.Unlock()
	return closeErr
}

func (s *subscription) abandonHeld(ctx context.Context, via receiver) {
	s.heldMu.Lock()
	held := make([]*delivery, 0, len(s.held))
	for del := range s.held {
		held = append(held, del)
		delete(s.held, del)
	}
	s.heldMu.Unlock()
	for _, del := range held {
		if del.settled.CompareAndSwap(false, true) {
			<-s.slots
			if via != nil {
				_ = via.AbandonMessage(ctx, del.msg, nil)
			}
		}
	}
}

func toWire(m *azservicebus.ReceivedMessage) transport.WireEvent {
	raw := make(map[string]string, len(m.ApplicationProperties)+1)
	for name, value := range m.ApplicationProperties {
		if value != nil {
			raw[name] = fmt.Sprint(value)
		}
	}
	if m.ContentType != nil {
		raw["content-type"] = *m.ContentType
	}
	return transport.WireEvent{Headers: transport.UnprefixHeaders(raw, HeaderPrefix), Body: m.Body}
}

type delivery struct {
	s       *subscription
	msg     *azservicebus.ReceivedMessage
	attempt int
	settled atomic.Bool
}

func (d *delivery) Attempt() int { return d.attempt }

func (d *delivery) Ack(ctx context.Context) error { return d.settle(ctx, true, false) }

func (d *delivery) Nack(ctx context.Context, requeue bool) error {
	return d.settle(ctx, false, requeue)
}

func (d *delivery) settle(ctx context.Context, ack, requeue bool) error {
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
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer cancel()
	return d.s.d.settleRetry(ctx, len(d.msg.Body), func(c context.Context) error {
		if !ack && requeue {
			return d.s.recv.AbandonMessage(c, d.msg, nil)
		}
		return d.s.recv.CompleteMessage(c, d.msg, nil)
	})
}

var (
	_ transport.Driver        = (*Driver)(nil)
	_ transport.StatsReporter = (*Driver)(nil)
)
