/**
 * The broker driver contract (`@landflow/transports/driver`, docs/transports.md "One core, small drivers").
 *
 * A driver knows one broker and nothing about Landflow: it moves opaque `WireEvent`s (headers + bytes) between named
 * channels, shares a channel's events between competing consumers, acknowledges, and reports what it can observe. The
 * messaging core (`MessagingClient`, `MessagingServer`) adds everything Landflow-specific on top: the CloudEvents
 * envelope, correlation and replies, deadlines, cancellation, delivery modes, signing and encryption, announcing,
 * stats. A driver must never read or change event headers or bodies, except to carry them.
 *
 * Layout for driver authors: one directory per broker kind, `src/drivers/<kind>/index.ts`, exported from `package.json`
 * as `@landflow/transports/<kind>` (`./kafka`, `./amqp`, `./nats`, `./valkey`, …). The broker's client library is an
 * **optional peer dependency** of this package, imported lazily inside the driver module (`await import('amqplib')` in
 * `connect()`), so the host and the SDK load only the clients they use; never import a client library from the core.
 * Each driver ships `<kind>.conformance.test.ts` next to it, which calls `runConformance()` from
 * `@landflow/transports/conformance` against the local container, gated on an env var (`LANDFLOW_TEST_KAFKA=…`) and
 * skipping with a message when the broker is not reachable. `capabilities` must be honest: the suite checks every claim.
 */

/** Known broker kinds plus room for new ones; the kind is the scheme of brokered endpoints, `<kind>://<connectionId>/<pluginId>`. */
export type BrokerKind = 'kafka' | 'amqp' | 'nats' | 'valkey' | 'mqtt' | 'sqs' | 'pubsub' | 'servicebus' | 'amqp1' | 'pulsar' | 'memory' | (string & {});

/**
 * What the core and the selector may rely on. Every member is checked by the conformance suite, so claim only what the
 * broker really does. The core adapts: structured mode without headers, a reply channel without native replies, its own
 * deadline check without TTL, consumer-heartbeat inference without undeliverable reports.
 */
export interface BrokerCapabilities {
  /**
   * `native`: the broker answers a request on the same connection (NATS inboxes, RabbitMQ direct reply-to, MQTT response
   * topics); the driver implements `request()` and `Delivery.reply()`. `reply-channel`: the core declares a reply channel
   * per host process and correlates replies itself (Kafka, SQS, Pub/Sub, Streams).
   */
  replies: 'native' | 'reply-channel';
  /** Consumers with the same `ConsumeOptions.group` share a channel's events (queue, consumer group, queue group, shared subscription). */
  workSharing: boolean;
  /** The broker holds events published while no consumer is attached, and delivers them when one arrives. */
  buffering: boolean;
  /** The broker drops events itself after `PublishOptions.ttlMs` (a first filter only; the core checks `lfdeadline` anyway). */
  ttl: boolean;
  /**
   * `reported`: `publish()` returns `unroutable` at once when nobody can take the event (NATS no responders, RabbitMQ
   * `mandatory`). `inferred`: `stats().consumers` is reliable, so the core infers it. `unknown`: only the deadline tells.
   */
  undeliverable: 'reported' | 'inferred' | 'unknown';
  /** `disk`: events survive on disk (Kafka, Streams, SQS…), so end-to-end encryption is mandatory; the core encrypts in both cases. */
  persistence: 'memory' | 'disk';
  /** Largest event (headers + body) the broker accepts; the core refuses bigger ones before publishing (`too_large`). */
  maxMessageBytes: number;
  /** A prior for the selector before it has measurements. */
  latency: 'low' | 'medium' | 'high';
  /** The broker carries string headers with each event: the core uses CloudEvents binary mode. Else structured mode (one JSON document). */
  headers: boolean;
  /** Header budget in bytes when `headers` (Azure Service Bus: 64 KiB). Absent: no budget beyond `maxMessageBytes`. */
  maxHeaderBytes?: number;
  /** `PublishOptions.orderingKey` is honoured (Kafka record key, Pub/Sub ordering key, Service Bus session id). */
  orderingKeys: boolean;
  /**
   * `Delivery.nack({ requeue: true })` puts the event back for another consumer (RabbitMQ, JetStream, Pulsar, Streams
   * XCLAIM, SQS visibility). `false`: the driver drops on nack, and the core treats redelivery as impossible.
   */
  nack: boolean;
  /** `Delivery.attempt` counts redeliveries truthfully (RabbitMQ `redelivered`, JetStream `numDelivered`, SQS receive count). Else it is always 1. */
  attempts: boolean;
}

/** The common part of every driver's connection config; drivers extend it with their own (`KafkaConfig extends BrokerConfig`). */
export interface BrokerConfig {
  /** The host-side name of this broker connection (`kafka-main`): the authority of brokered endpoints. 1–64 chars of `[a-zA-Z0-9._-]`. */
  connectionId: string;
  /** Channel-name prefix (default `landflow`). Lets two Landflow instances share a broker. */
  prefix?: string;
}

/** What a channel is for. Drivers map roles to the broker's own primitives (queue, topic, subject, stream). */
export type ChannelRole = 'request' | 'instance' | 'reply' | 'registry' | 'control';

export interface ChannelSpec {
  /** Full channel name, already prefixed (`landflow.v1.plugin.twilio`). Drivers may translate characters the broker forbids, consistently. */
  name: string;
  role: ChannelRole;
  /** `shared`: consumers in a group compete for events (request channels). `broadcast`: every consumer gets every event (registry, control, reply). */
  delivery: 'shared' | 'broadcast';
  /** Events should survive the consumer being away (request channels: `true`; reply, registry, control: `false`). */
  durable: boolean;
  /** Events older than this may be dropped by the broker, when `capabilities.ttl`. */
  ttlMs?: number;
}

/**
 * One event on the wire: string headers and bytes. The core fills `headers` with the CloudEvents attributes and extensions
 * under their **bare** names (`specversion`, `id`, `type`, `lfsig`, …) plus `content-type` in binary mode, and with
 * `content-type` only in structured mode. Drivers apply their binding's prefix (`ce_` for Kafka, `cloudEvents_` for AMQP,
 * `ce-` for NATS, none for MQTT 5 user properties) with `prefixHeaders()` / `unprefixHeaders()` from the core and must
 * return header names lower-cased. Header names and values are ASCII-safe (`[a-z0-9-]` names; values never contain
 * control characters), so no escaping is needed.
 */
export interface WireEvent {
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface PublishOptions {
  /** Keeps events with the same key in order and on the same partition / session, when `capabilities.orderingKeys`. */
  orderingKey?: string;
  /** Drop the event after this many ms if still undelivered, when `capabilities.ttl`. */
  ttlMs?: number;
}

/** `unroutable`: the broker reported at once that nobody can take the event. Only drivers with `undeliverable: 'reported'` return it. */
export type PublishOutcome = 'accepted' | 'unroutable';

export interface RequestOptions {
  /** Give up waiting for the native reply after this long; the driver returns `{ outcome: 'timeout' }`, never throws for it. */
  timeoutMs: number;
  orderingKey?: string;
}

/** Outcome of a native request (`capabilities.replies: 'native'`). */
export type RequestOutcome = { outcome: 'replied'; event: WireEvent } | { outcome: 'unroutable' } | { outcome: 'timeout' };

export interface ConsumeOptions {
  /**
   * Work-sharing group: consumers with the same group compete for the channel's events (the core uses the channel name).
   * Absent: this consumer gets every event (reply, registry, control channels).
   */
  group?: string;
  /** Most deliveries this consumer holds unacknowledged at once (the plugin's `maxConcurrency`). */
  prefetch: number;
  /** `manual`: the core acks/nacks each delivery. `auto`: acknowledged on delivery, never redelivered (reply, registry, control). */
  ackMode: 'manual' | 'auto';
}

/** One delivery of an event to one consumer. Methods are no-ops after the first ack/nack and in `auto` ack mode. */
export interface Delivery {
  /** 1 on the first delivery; a redelivery increments it when `capabilities.attempts`. */
  readonly attempt: number;
  /** Done with it: the broker forgets the event (commit, ack, XACK, DeleteMessage). */
  ack(): Promise<void>;
  /** Not done: `requeue: true` lets another consumer take it (when `capabilities.nack`); `false` drops it. */
  nack(options?: { requeue?: boolean }): Promise<void>;
  /** Native reply to this event's requester; present only when `capabilities.replies` is `native`. */
  reply?(event: WireEvent): Promise<void>;
}

/** The core's handler. It returns once it has acked, nacked or decided to hold the delivery; it never throws for a bad event. */
export type ConsumeHandler = (event: WireEvent, delivery: Delivery) => Promise<void>;

export interface Subscription {
  readonly channel: string;
  /** Stop delivering. Deliveries still unacknowledged go back to the broker (as if the consumer had died). */
  close(): Promise<void>;
}

export interface ChannelStats {
  /** Events waiting for a consumer. */
  depth?: number;
  /** Consumers attached (in any group). */
  consumers?: number;
  /** Consumer-group lag in events (Kafka, Streams), when the broker distinguishes it from depth. */
  lag?: number;
}

/**
 * A connection to one broker. One instance = one connection; `connect()` is called once, `close()` ends everything
 * (subscriptions included). Every method may be called concurrently with the others once connected. Errors from the
 * broker surface as rejected promises with the client library's message; the core wraps them.
 */
export interface BrokerDriver<C extends BrokerConfig = BrokerConfig> {
  readonly kind: BrokerKind;
  readonly capabilities: BrokerCapabilities;
  /** Open the connection; a rejection means nothing was sent anywhere (the core reports `not_connected`, provably undelivered). */
  connect(config: C): Promise<void>;
  /** Create (or verify) channels; idempotent. Called before the first publish/consume on each channel. */
  declare(channels: ChannelSpec[]): Promise<void>;
  /** Send one event; resolves once the broker accepted it (producer ack where the broker has one). */
  publish(channel: string, event: WireEvent, options?: PublishOptions): Promise<PublishOutcome>;
  /** Start receiving; `onEvent` is called at most `prefetch` times concurrently in `manual` mode. */
  consume(channel: string, options: ConsumeOptions, onEvent: ConsumeHandler): Promise<Subscription>;
  /** Native request/reply (required when `capabilities.replies` is `native`). */
  request?(channel: string, event: WireEvent, options: RequestOptions): Promise<RequestOutcome>;
  /** Cheap observation for the selector (sampled every 5 s by the host). Return `{}` for what the broker cannot tell. */
  stats?(channel: string): Promise<ChannelStats>;
  /** Close subscriptions and the connection. Idempotent. */
  close(): Promise<void>;
}

/**
 * Thrown by `publish()` / `request()` when the connection is down **before anything was sent** (never connected, closed,
 * reconnecting). The core reports the call as provably undelivered (`not_connected`), so the selector may use another
 * transport. Any other rejection from `publish()` is treated as "maybe sent".
 */
export class NotConnectedError extends Error {
  constructor(message = 'not connected to the broker') {
    super(message);
    this.name = 'NotConnectedError';
  }
}

/** Add a binding's header prefix (`ce_`) to every CloudEvents header except `content-type`; a helper for drivers. */
export function prefixHeaders(headers: Record<string, string>, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) out[name === 'content-type' ? name : prefix + name] = value;
  return out;
}

/** The inverse of `prefixHeaders`: strips `prefix`, lower-cases names and drops headers that are neither prefixed nor `content-type`. */
export function unprefixHeaders(headers: Record<string, string | undefined>, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const name = rawName.toLowerCase();
    if (name === 'content-type') out[name] = value;
    else if (name.startsWith(prefix.toLowerCase())) out[name.slice(prefix.length)] = value;
  }
  return out;
}
