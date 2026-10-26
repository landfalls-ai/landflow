/**
 * Transports (docs/transports.md): the per-plugin transport policy, the choice made for a call and its reason, the
 * installed transport kinds and broker connections. Shared by the API routes, the Plugins page and
 * Settings → Transports. No runtime imports.
 */

import type { BrokerTransportKind, TransportKind } from '@landflow/protocol';

/**
 * A transport kind: `http` and `grpc` (direct: the host connects to the plugin) or a broker kind (`kafka`, `amqp`,
 * `nats`, `valkey`, `mqtt`, `sqs`, `pubsub`, `servicebus`, `amqp1`, `pulsar`: both sides connect out). Open: the
 * protocol's known kinds autocomplete, any other string is accepted (`@landflow/protocol`, transport.ts).
 */
export type { BrokerTransportKind, TransportKind };

export const TRANSPORT_KIND_LABELS: Record<string, string> = {
  'in-process': 'in-process',
  http: 'HTTP',
  grpc: 'gRPC',
  kafka: 'Kafka',
  amqp: 'RabbitMQ (AMQP 0-9-1)',
  nats: 'NATS',
  jetstream: 'NATS JetStream',
  valkey: 'Valkey / Redis Streams',
  mqtt: 'MQTT 5',
  sqs: 'Amazon SQS',
  pubsub: 'Google Pub/Sub',
  servicebus: 'Azure Service Bus',
  amqp1: 'AMQP 1.0',
  pulsar: 'Apache Pulsar',
};

/** A kind's label for people (`kafka` → "Kafka"); an unknown kind is shown as is. */
export const transportLabel = (kind: string) => TRANSPORT_KIND_LABELS[kind] ?? kind;

export type TransportPolicyMode = 'auto' | 'pinned';
export type TransportObjective = 'balanced' | 'latency' | 'throughput';

/**
 * How a plugin's calls choose their transport (Settings → Plugins; `plugin_transport_policies`, migration 1700).
 * `auto` (the default) lets the selector choose among the transports both sides have; `pinned` always uses one;
 * `allowed` limits the choice either way. `objective` is Auto's goal.
 */
export interface TransportPolicy {
  mode: TransportPolicyMode;
  /** With `mode: 'pinned'`: the kind every call uses. */
  pinned?: TransportKind;
  /** Kinds the selector may use; unset = every kind. */
  allowed?: TransportKind[];
  objective: TransportObjective;
}

export const DEFAULT_TRANSPORT_POLICY: TransportPolicy = { mode: 'auto', objective: 'balanced' };

/**
 * A workflow's override of one plugin's policy (workflow settings `transports`, by plugin id), for that workflow's runs:
 * the fields it sets replace the plugin's, except `allowed`, which only narrows the plugin's allow-list. `pinned`
 * without `mode` pins.
 */
export type WorkflowTransportOverride = Partial<TransportPolicy>;

/**
 * Why a call went over its transport (`landflow.transport.reason` on `plugin.rpc` spans): the policy pinned it, it was
 * the only one, or Auto chose it for latency, spill-over, failover, an open breaker or the call's size.
 */
export type TransportReason = 'pinned' | 'only' | 'auto.latency' | 'auto.spillover' | 'auto.failover' | 'auto.breaker' | 'auto.size';

/** The transport chosen for a call (or for the Plugins page: the one the next call would take). */
export interface TransportChoice {
  endpoint: string;
  kind: TransportKind;
  reason: TransportReason;
  /** The numbers behind the reason, for people ("gRPC at 14 of 16 calls", "breaker open on grpc://…"). */
  detail?: string;
}

/** A circuit breaker's state (docs/transports.md rule 6): open after 5 failures in a row or more than half of the last 20, half-open after 15 s. */
export type BreakerState = 'closed' | 'open' | 'half-open';

/**
 * Auto's numbers for one transport kind or endpoint of a plugin (lib/server/transports/auto.ts), over the last 60 s:
 * what the Plugins page shows next to each transport.
 */
export interface TransportAutoSummary {
  /** Latency percentiles of the calls in the window (probes excluded while there are calls), in ms. */
  p50Ms?: number;
  p95Ms?: number;
  /** Calls in flight now, and the plugin's `maxConcurrency` (direct kinds: the plugin's one process behind HTTP and gRPC). */
  inflight: number;
  limit?: number;
  /** Transport failures and timeouts over the calls of the window (a node error in a normal reply doesn't count), 0..1. */
  errorRate?: number;
  /** Calls in the window. */
  calls: number;
  breaker: BreakerState;
  /** A remote `capacity` refusal asked to wait until then (ISO). */
  retryAfterUntil?: string;
  /** The kind hysteresis settled on as the plugin's main transport. */
  main?: boolean;
  /** Production calls spill over to this kind right now. */
  spilling?: boolean;
}

/** One of a plugin's transports on the Plugins page: its kind, its endpoints and whether any of them is online. */
export interface PluginTransportSummary {
  kind: TransportKind;
  endpoints: string[];
  online: boolean;
  /** The policy keeps this kind out (not allowed, or another one is pinned). */
  excluded?: boolean;
  /** The plugin says it was built with this face (manifest `transports`) but no endpoint on it has been found. */
  declared?: boolean;
  /** Live numbers for the kind: brokers sum their endpoints' queue stats; every kind reports the plugin's `maxConcurrency` when known. */
  stats?: BrokerQueueStats;
  /** Auto's measurements for the kind: p50/p95, in flight against the limit, error rate, breaker state. */
  auto?: TransportAutoSummary;
}

/**
 * What the host knows about a plugin's request channel on a broker (the selector's queue inputs; the Plugins page shows
 * them): sampled every 5 s by the messaging client (`MessagingClient.stats()`), plus the announced instances.
 */
export interface BrokerQueueStats {
  /** Events waiting for a consumer. */
  depth?: number;
  /** Consumers attached to the request channel. */
  consumers?: number;
  /** Consumer-group lag, when the broker distinguishes it from depth. */
  lag?: number;
  /** Instances that announced themselves on the channel and have not expired. */
  instances?: number;
  /** The announced instances' `maxConcurrency` summed (how many calls the plugin takes at once over this transport). */
  maxConcurrency?: number;
  /** When `depth`/`consumers`/`lag` were sampled (ISO); absent when the broker reports no stats. */
  sampledAt?: string;
}

/** What a transport can carry, as the provider reports it (the selector's capability inputs). */
export interface TransportCapabilities {
  /** The largest request or reply the transport carries; `Infinity` for direct transports. */
  maxMessageBytes: number;
  delivery: Array<'at-most-once' | 'at-least-once'>;
  /** A prior for the selector before it has measurements. */
  latency: 'low' | 'medium' | 'high';
  /** Holds calls while consumers are busy (a spill-over target). */
  buffering: boolean;
}

/** An installed transport kind (GET /api/transports). */
export interface TransportKindInfo {
  kind: TransportKind;
  label: string;
  /** The host connects to the plugin (no connection rows); brokers are reached through connections. */
  direct: boolean;
  /** A provider (driver) for the kind is registered in this host. */
  installed: boolean;
  /** The provider's own state: a broker kind without the shared secret, or without an open connection, says so here. */
  health?: { ok: boolean; message?: string };
  capabilities?: TransportCapabilities;
  /** The connection fields the kind's form shows. */
  fields: ConnectionField[];
}

/** One field of a broker connection's form. Secret fields are stored encrypted and never sent back. */
export interface ConnectionField {
  name: string;
  label: string;
  type: 'string' | 'password' | 'boolean' | 'textarea' | 'number';
  required?: boolean;
  placeholder?: string;
  hint?: string;
}

/** The outcome of Test on a connection (and its health, once drivers keep connections open). */
export interface TransportConnectionCheck {
  ok: boolean;
  at: string;
  message: string;
  latencyMs?: number;
  version?: string;
}

/**
 * The state of the broker connection this host process holds open (lib/server/transports/brokers.ts): connecting on
 * start, connected once the client is up and a round trip worked, reconnecting after the connection was lost, error when
 * it cannot open (with the message: a refused connection, bad credentials, no shared secret).
 */
export interface TransportConnectionHealth {
  state: 'connecting' | 'connected' | 'reconnecting' | 'error';
  message?: string;
  /** When the state was entered (ISO). */
  since: string;
  /** The last publish/consume round trip through the connection, in ms. */
  roundTripMs?: number;
  /** When the round trip was measured (ISO). */
  checkedAt?: string;
  /** The broker's version, when the driver can tell. */
  version?: string;
  /** This host process's id (its reply channel is named after it). */
  hostInstanceId?: string;
  /** Plugins currently announced on this connection. */
  announced?: number;
}

/** A broker connection as the API shows it: config without secret values, and which secret fields are set. */
export interface TransportConnectionView {
  id: string;
  name: string;
  kind: TransportKind;
  enabled: boolean;
  /** Non-secret config (a URL's user info is masked). */
  config: Record<string, string | boolean>;
  /** Secret fields that hold a value (their values never leave the host). */
  secretsSet: string[];
  /** `database`: added in Settings; `env`: from `LANDFLOW_TRANSPORT_<KIND>_URL`, read-only. */
  source: 'database' | 'env';
  lastCheck?: TransportConnectionCheck;
  /** The live connection this host holds (absent for a disabled connection or a kind without a driver). */
  health?: TransportConnectionHealth;
  /** Plugins with an endpoint on this connection (`<kind>://<connectionId>/<pluginId>`). */
  plugins: string[];
  createdAt: string;
  updatedAt: string;
}

/** GET /api/transports */
export interface TransportsResponse {
  kinds: TransportKindInfo[];
  connections: TransportConnectionView[];
  /**
   * The claim check: whether this host has a store (`LANDFLOW_CLAIM_STORE`) that carries bodies too big for a broker by
   * reference. Without one, such a call fails `too_large` and may use another transport. `error` says why a malformed
   * setting was ignored; `description` is the setting without credentials.
   */
  claimStore?: { configured: boolean; description?: string; error?: string };
}
