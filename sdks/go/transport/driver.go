// Package transport is Landflow's generic messaging over brokers for Go: the
// Go mirror of the TypeScript package @landflow/transports (docs/transports.md
// "Generic messaging", docs/protocol.md §14). It is byte-compatible with the TS
// core: a Go plugin served over a broker answers a TS host and the reverse.
//
//   - Client (host side) and Server (plugin side) are the core, written once.
//   - The CloudEvents envelope (envelope.go), channel names (channels.go),
//     signing and encryption (security.go), the codec (codec.go) and the typed
//     errors the selector acts on (errors.go).
//   - This file is the driver contract. Drivers live in subpackages
//     (transport/memory, transport/kafka, transport/amqp, transport/nats,
//     transport/valkey, …) and register themselves with RegisterDriver in init(),
//     so a plugin enables one with a blank import. The conformance suite
//     (transport/conformance) checks every capability a driver claims.
//
// # Driver contract
//
// A driver knows one broker and nothing about Landflow: it moves opaque
// WireEvents (headers + bytes) between named channels, shares a channel's
// events between competing consumers, acknowledges, and reports what it can
// observe. The core adds everything Landflow-specific on top: the CloudEvents
// envelope, correlation and replies, deadlines, cancellation, delivery modes,
// signing and encryption, announcing, stats. A driver must never read or change
// event headers or bodies, except to carry them.
//
// Shape: a driver package exports a config struct that embeds transport.Config
// (the common part: connection id and channel prefix) and a constructor taking
// it, `kafka.New(kafka.Config{...}) *kafka.Driver`, which returns an unconnected
// driver. The core calls Connect once, then Declare/Publish/Consume
// concurrently, then Close. Nothing is sent before Connect returns nil. The
// package also registers a Factory in init() so env-driven use
// (LANDFLOW_TRANSPORTS=kafka + LANDFLOW_KAFKA_URL) can build the same driver
// from a URL without the plugin importing the config type.
//
// Each driver package ships a conformance test that runs
// conformance.Run against the local container, gated on an env var
// (LANDFLOW_TEST_KAFKA=…) and skipping when the broker is not reachable. The
// broker client library is a dependency of the driver package only (a nested
// module per driver is fine); sdks/go's own go.mod stays free of them.
package transport

import (
	"context"
	"errors"
	"sort"
	"strings"
	"sync"
	"time"
)

// ReplyMode says how a broker carries replies.
type ReplyMode string

const (
	// RepliesNative: the broker answers a request on the same connection (NATS
	// inboxes, RabbitMQ direct reply-to, MQTT response topics). The driver
	// implements Requester and its deliveries implement Replier.
	RepliesNative ReplyMode = "native"
	// RepliesChannel: the core declares a reply channel per host process and
	// correlates replies itself (Kafka, SQS, Pub/Sub, Streams).
	RepliesChannel ReplyMode = "reply-channel"
)

// UndeliverableMode says how the core learns that nobody can take an event.
type UndeliverableMode string

const (
	// UndeliverableReported: Publish returns Unroutable at once when nobody can
	// take the event (NATS no responders, RabbitMQ `mandatory`).
	UndeliverableReported UndeliverableMode = "reported"
	// UndeliverableInferred: Stats().Consumers is reliable, so the core infers it.
	UndeliverableInferred UndeliverableMode = "inferred"
	// UndeliverableUnknown: only the deadline tells.
	UndeliverableUnknown UndeliverableMode = "unknown"
)

// Persistence says where the broker keeps events.
type Persistence string

const (
	PersistenceMemory Persistence = "memory"
	// PersistenceDisk: events survive on disk (Kafka, Streams, SQS…), so
	// end-to-end encryption is mandatory. The core encrypts in both cases.
	PersistenceDisk Persistence = "disk"
)

// Latency is a prior for the selector before it has measurements.
type Latency string

const (
	LatencyLow    Latency = "low"
	LatencyMedium Latency = "medium"
	LatencyHigh   Latency = "high"
)

// Capabilities is what the core and the host's selector may rely on. Every
// member is checked by the conformance suite, so claim only what the broker
// really does. The core adapts: structured mode without headers, a reply
// channel without native replies, its own deadline check without TTL,
// consumer-heartbeat inference without undeliverable reports. Same fields and
// meanings as the TS BrokerCapabilities.
type Capabilities struct {
	// Replies: RepliesNative or RepliesChannel.
	Replies ReplyMode
	// WorkSharing: consumers with the same ConsumeOptions.Group share a channel's
	// events (queue, consumer group, queue group, shared subscription).
	WorkSharing bool
	// Buffering: the broker holds events published while no consumer is
	// attached, and delivers them when one arrives.
	Buffering bool
	// TTL: the broker drops events itself after PublishOptions.TTL (a first
	// filter only; the core checks lfdeadline anyway).
	TTL bool
	// Undeliverable: how the core learns that nobody can take an event.
	Undeliverable UndeliverableMode
	// Persistence: PersistenceMemory or PersistenceDisk.
	Persistence Persistence
	// MaxMessageBytes is the largest event (headers + body) the broker accepts;
	// the core refuses bigger ones before publishing (too_large).
	MaxMessageBytes int
	// Latency is a prior for the selector.
	Latency Latency
	// Headers: the broker carries string headers with each event, so the core
	// uses CloudEvents binary mode. Else structured mode (one JSON document).
	Headers bool
	// MaxHeaderBytes is the header budget in bytes when Headers (Azure Service
	// Bus: 64 KiB). 0: no budget beyond MaxMessageBytes.
	MaxHeaderBytes int
	// OrderingKeys: PublishOptions.OrderingKey is honoured (Kafka record key,
	// Pub/Sub ordering key, Service Bus session id).
	OrderingKeys bool
	// Nack: Delivery.Nack(ctx, true) puts the event back for another consumer
	// (RabbitMQ, JetStream, Pulsar, Streams XCLAIM, SQS visibility). false: the
	// driver drops on nack, and the core treats redelivery as impossible.
	Nack bool
	// Attempts: Delivery.Attempt counts redeliveries truthfully (RabbitMQ
	// `redelivered`, JetStream `numDelivered`, SQS receive count). Else always 1.
	Attempts bool
}

// Config is the common part of every driver's connection config; driver
// packages embed it in their own (`type Config struct { transport.Config;
// Brokers []string; … }`).
type Config struct {
	// ConnectionID is the host-side name of this broker connection
	// ("kafka-main"): the authority of brokered endpoints
	// `<kind>://<connectionId>/<pluginId>`. 1–64 chars of [a-zA-Z0-9._-]. A
	// plugin configured from env uses "env-<kind>", the id the host gives the
	// connection it reads from LANDFLOW_TRANSPORT_<KIND>_URL.
	ConnectionID string
	// Prefix is the channel-name prefix (default "landflow", see DefaultPrefix).
	// Lets two Landflow instances share a broker.
	Prefix string
}

// ChannelRole is what a channel is for. Drivers map roles to the broker's own
// primitives (queue, topic, subject, stream).
type ChannelRole string

const (
	RoleRequest  ChannelRole = "request"
	RoleInstance ChannelRole = "instance"
	RoleReply    ChannelRole = "reply"
	RoleRegistry ChannelRole = "registry"
	RoleControl  ChannelRole = "control"
)

// ChannelDelivery is how a channel fans out. (The envelope's at-most-once /
// at-least-once choice is DeliveryMode in envelope.go.)
type ChannelDelivery string

const (
	// DeliveryShared: consumers in a group compete for events (request channels).
	DeliveryShared ChannelDelivery = "shared"
	// DeliveryBroadcast: every consumer gets every event (registry, control, reply).
	DeliveryBroadcast ChannelDelivery = "broadcast"
)

// ChannelSpec describes one channel for Declare.
type ChannelSpec struct {
	// Name is the full channel name, already prefixed
	// ("landflow.v1.plugin.twilio"). Drivers may translate characters the
	// broker forbids, consistently.
	Name string
	Role ChannelRole
	// Delivery: DeliveryShared or DeliveryBroadcast.
	Delivery ChannelDelivery
	// Durable: events should survive the consumer being away (request
	// channels: true; reply, registry, control: false).
	Durable bool
	// TTL: events older than this may be dropped by the broker, when
	// Capabilities.TTL. 0 = none.
	TTL time.Duration
}

// WireEvent is one event on the wire: string headers and bytes. The core fills
// Headers with the CloudEvents attributes and extensions under their bare names
// ("specversion", "id", "type", "lfsig", …) plus "content-type" in binary mode,
// and with "content-type" only in structured mode. Drivers apply their
// binding's prefix ("ce_" for Kafka, "cloudEvents_" for AMQP, "ce-" for NATS,
// none for MQTT 5 user properties) with PrefixHeaders / UnprefixHeaders and
// must return header names lower-cased. Header names and values are ASCII-safe
// ([a-z0-9-] names; values never contain control characters), so no escaping is
// needed. Headers may be nil when the broker carries none.
type WireEvent struct {
	Headers map[string]string
	Body    []byte
}

// PublishOptions tunes one Publish.
type PublishOptions struct {
	// OrderingKey keeps events with the same key in order and on the same
	// partition / session, when Capabilities.OrderingKeys.
	OrderingKey string
	// TTL: drop the event after this long if still undelivered, when
	// Capabilities.TTL. 0 = none.
	TTL time.Duration
}

// PublishOutcome is the result of a successful Publish.
type PublishOutcome string

const (
	// Accepted: the broker took the event.
	Accepted PublishOutcome = "accepted"
	// Unroutable: the broker reported at once that nobody can take the event.
	// Only drivers with UndeliverableReported return it.
	Unroutable PublishOutcome = "unroutable"
)

// RequestOptions tunes one native Request.
type RequestOptions struct {
	// Timeout: give up waiting for the native reply after this long; the
	// driver returns RequestTimeout, never an error for it.
	Timeout     time.Duration
	OrderingKey string
}

// RequestOutcome is the result kind of a native request.
type RequestOutcome string

const (
	RequestReplied    RequestOutcome = "replied"
	RequestUnroutable RequestOutcome = "unroutable"
	RequestTimeout    RequestOutcome = "timeout"
)

// RequestResult is the outcome of a native request (Capabilities.Replies ==
// RepliesNative). Event is set only when Outcome is RequestReplied.
type RequestResult struct {
	Outcome RequestOutcome
	Event   WireEvent
}

// AckMode says who acknowledges deliveries.
type AckMode string

const (
	// AckManual: the core acks/nacks each delivery.
	AckManual AckMode = "manual"
	// AckAuto: acknowledged on delivery, never redelivered (reply, registry, control).
	AckAuto AckMode = "auto"
)

// ConsumeOptions tunes one Consume.
type ConsumeOptions struct {
	// Group is the work-sharing group: consumers with the same group compete
	// for the channel's events (the core uses the channel name). Empty: this
	// consumer gets every event (reply, registry, control channels).
	Group string
	// Prefetch is the most deliveries this consumer holds unacknowledged at
	// once (the plugin's maxConcurrency). At least 1.
	Prefetch int
	// AckMode: AckManual or AckAuto.
	AckMode AckMode
}

// Delivery is one delivery of an event to one consumer. Ack and Nack are
// no-ops after the first of them and in AckAuto mode. A delivery of a driver
// with native replies also implements Replier.
type Delivery interface {
	// Attempt is 1 on the first delivery; a redelivery increments it when
	// Capabilities.Attempts.
	Attempt() int
	// Ack: done with it; the broker forgets the event (commit, ack, XACK, DeleteMessage).
	Ack(ctx context.Context) error
	// Nack: not done. requeue lets another consumer take it (when
	// Capabilities.Nack); false drops it.
	Nack(ctx context.Context, requeue bool) error
}

// Replier is implemented by the deliveries of a driver whose Capabilities.Replies
// is RepliesNative: a native reply to this event's requester. The core asserts
// `delivery.(Replier)`.
type Replier interface {
	Reply(ctx context.Context, event WireEvent) error
}

// Handler is the core's consume callback. It returns once it has acked, nacked
// or decided to hold the delivery; it never panics for a bad event. ctx is the
// subscription's context: it is cancelled when the subscription closes. In
// AckManual mode the driver calls it at most ConsumeOptions.Prefetch times
// concurrently.
type Handler func(ctx context.Context, event WireEvent, delivery Delivery)

// Subscription is one active Consume.
type Subscription interface {
	// Channel is the channel name as given to Consume.
	Channel() string
	// Close stops delivering. Deliveries still unacknowledged go back to the
	// broker (as if the consumer had died). Idempotent.
	Close(ctx context.Context) error
}

// ChannelStats is a cheap observation for the selector. A nil field means the
// broker cannot tell.
type ChannelStats struct {
	// Depth: events waiting for a consumer.
	Depth *int
	// Consumers attached (in any group).
	Consumers *int
	// Lag: consumer-group lag in events (Kafka, Streams), when the broker
	// distinguishes it from depth.
	Lag *int
}

// Int returns a pointer to v, for ChannelStats fields.
func Int(v int) *int { return &v }

// Driver is a connection to one broker. One instance = one connection: Connect
// is called once, Close ends everything (subscriptions included). Every method
// may be called concurrently with the others once connected. Errors from the
// broker surface as the client library's error; the core wraps them. A driver
// may also implement Requester and StatsReporter.
type Driver interface {
	// Kind names the broker: the scheme of brokered endpoints ("kafka", "amqp",
	// "nats", "valkey", "mqtt", "sqs", "pubsub", "servicebus", "amqp1",
	// "pulsar", "memory").
	Kind() string
	// Capabilities is honest about what the broker does; it never changes
	// after construction.
	Capabilities() Capabilities
	// Config is the common part of the driver's configuration (connection id,
	// channel prefix). The core reads the prefix for channel names and the
	// connection id for endpoints.
	Config() Config
	// Connect opens the connection. An error means nothing was sent anywhere
	// (the core reports not_connected, provably undelivered). ctx bounds the
	// attempt only; the connection outlives it.
	Connect(ctx context.Context) error
	// Declare creates (or verifies) channels; idempotent. Called before the
	// first Publish/Consume on each channel.
	Declare(ctx context.Context, channels []ChannelSpec) error
	// Publish sends one event; it returns once the broker accepted it (producer
	// ack where the broker has one). It returns an error wrapping
	// ErrNotConnected when the connection is down before anything was sent.
	Publish(ctx context.Context, channel string, event WireEvent, opts PublishOptions) (PublishOutcome, error)
	// Consume starts receiving; handler is called at most opts.Prefetch times
	// concurrently in AckManual mode. ctx bounds the setup only; the
	// subscription lives until Close.
	Consume(ctx context.Context, channel string, opts ConsumeOptions, handler Handler) (Subscription, error)
	// Close closes subscriptions and the connection. Idempotent.
	Close() error
}

// Requester is implemented by drivers whose Capabilities.Replies is
// RepliesNative: native request/reply. The core asserts `driver.(Requester)`.
type Requester interface {
	// Request publishes event and waits for the native reply. A timeout is a
	// RequestTimeout result, never an error. An error wrapping ErrNotConnected
	// means nothing was sent.
	Request(ctx context.Context, channel string, event WireEvent, opts RequestOptions) (RequestResult, error)
}

// StatsReporter is implemented by drivers that can observe a channel (sampled
// every 5 s by the host). Return the zero ChannelStats for what the broker
// cannot tell.
type StatsReporter interface {
	Stats(ctx context.Context, channel string) (ChannelStats, error)
}

// ErrNotConnected is returned (wrapped) by Publish / Request when the connection
// is down before anything was sent (never connected, closed, reconnecting). The
// core reports the call as provably undelivered (not_connected), so the
// selector may use another transport. Any other error from Publish is treated
// as "maybe sent". Drivers: `return "", fmt.Errorf("kafka: %w", transport.ErrNotConnected)`.
var ErrNotConnected = errors.New("not connected to the broker")

// IsNotConnected reports whether err wraps ErrNotConnected.
func IsNotConnected(err error) bool { return errors.Is(err, ErrNotConnected) }

// PrefixHeaders adds a binding's header prefix ("ce_") to every CloudEvents
// header except "content-type"; a helper for drivers.
func PrefixHeaders(headers map[string]string, prefix string) map[string]string {
	out := make(map[string]string, len(headers))
	for name, value := range headers {
		if name == "content-type" {
			out[name] = value
		} else {
			out[prefix+name] = value
		}
	}
	return out
}

// UnprefixHeaders is the inverse of PrefixHeaders: it strips prefix,
// lower-cases names and drops headers that are neither prefixed nor
// "content-type".
func UnprefixHeaders(headers map[string]string, prefix string) map[string]string {
	out := make(map[string]string, len(headers))
	lower := strings.ToLower(prefix)
	for rawName, value := range headers {
		name := strings.ToLower(rawName)
		if name == "content-type" {
			out[name] = value
		} else if strings.HasPrefix(name, lower) {
			out[name[len(prefix):]] = value
		}
	}
	return out
}

// ConnectionOptions is what a connection gives a driver beyond its URL: the
// host's connection fields (secrets already unsealed) or the plugin's env
// (LANDFLOW_<KIND>_USERNAME, _PASSWORD, _TLS, _PREFIX, and _<FIELD> for
// driver-specific fields).
type ConnectionOptions struct {
	Username string
	Password string
	TLS      bool
	// Prefix is the channel-name prefix (default "landflow").
	Prefix string
	// Fields holds driver-specific fields by lower-case name (a Pub/Sub project
	// id, an SQS region).
	Fields map[string]string
}

// Factory builds an unconnected driver for a connection: connectionID becomes
// Config.ConnectionID, url is the broker URL ("kafka://b1:9092,b2:9092",
// "amqp://127.0.0.1:55672", "nats://127.0.0.1:54222", "redis://127.0.0.1:56379").
// It returns a readable error for a malformed URL or a missing required field,
// and never connects.
type Factory func(connectionID, url string, opts ConnectionOptions) (Driver, error)

var (
	registryMu sync.RWMutex
	registry   = map[string]Factory{}
)

// RegisterDriver makes a driver kind available to env-driven configuration
// (LANDFLOW_TRANSPORTS=…,kafka + LANDFLOW_KAFKA_URL). Driver packages call it
// from init(): `transport.RegisterDriver("kafka", func(id, url string, o
// transport.ConnectionOptions) (transport.Driver, error) { … })`, so a plugin
// enables a driver with a blank import (`_ ".../transport/kafka"`). Registering
// a kind twice panics; kind is lower-cased.
func RegisterDriver(kind string, factory Factory) {
	if kind == "" || factory == nil {
		panic("transport: RegisterDriver needs a kind and a factory")
	}
	kind = strings.ToLower(kind)
	registryMu.Lock()
	defer registryMu.Unlock()
	if _, dup := registry[kind]; dup {
		panic("transport: driver " + kind + " registered twice")
	}
	registry[kind] = factory
}

// LookupDriver returns the registered Factory for a kind (case-insensitive).
func LookupDriver(kind string) (Factory, bool) {
	registryMu.RLock()
	defer registryMu.RUnlock()
	f, ok := registry[strings.ToLower(kind)]
	return f, ok
}

// DriverKinds lists the registered kinds, sorted.
func DriverKinds() []string {
	registryMu.RLock()
	defer registryMu.RUnlock()
	kinds := make([]string, 0, len(registry))
	for k := range registry {
		kinds = append(kinds, k)
	}
	sort.Strings(kinds)
	return kinds
}
