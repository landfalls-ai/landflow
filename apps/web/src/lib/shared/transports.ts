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
 * Why a call went over its transport (`landflow.transport.reason` on `plugin.rpc` spans): the policy pinned it, it was
 * the only one, or Auto chose it for latency, spill-over, failover, an open breaker or the call's size.
 */
export type TransportReason = 'pinned' | 'only' | 'auto.latency' | 'auto.spillover' | 'auto.failover' | 'auto.breaker' | 'auto.size';

/** The transport chosen for a call (or for the Plugins page: the one the next call would take). */
export interface TransportChoice {
  endpoint: string;
  kind: TransportKind;
  reason: TransportReason;
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
  capabilities?: TransportCapabilities;
  /** The connection fields the kind's form shows. */
  fields: ConnectionField[];
}

/** One field of a broker connection's form. Secret fields are stored encrypted and never sent back. */
export interface ConnectionField {
  name: string;
  label: string;
  type: 'string' | 'password' | 'boolean' | 'textarea';
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
  /** Plugins with an endpoint on this connection (`<kind>://<connectionId>/<pluginId>`). */
  plugins: string[];
  createdAt: string;
  updatedAt: string;
}

/** GET /api/transports */
export interface TransportsResponse {
  kinds: TransportKindInfo[];
  connections: TransportConnectionView[];
}
