/**
 * `@landflow/transports/drivers`: how the host and the SDK find a broker driver by kind without importing every client.
 *
 * Each driver module (`src/drivers/<kind>/index.ts`, exported as `@landflow/transports/<kind>`) has a default export that
 * is a `DriverModule`: the kind, its capabilities, a factory for unconnected drivers, and the mapping from a connection
 * (a URL plus the host's connection fields, or a plugin's `LANDFLOW_<KIND>_URL`) to the driver's config. It also keeps
 * its own named exports (the driver class, its config type, the SDK helper such as `kafka({ brokers })`).
 *
 * `loadDriverModule(kind)` imports a module on first use. The import paths are static strings so bundlers (Next.js)
 * can resolve them; importing a driver module never loads its client library, which happens inside `connect()`.
 * Driver authors add their kind to `LOADERS` (one line each) when the module lands.
 */
import type { BrokerCapabilities, BrokerConfig, BrokerDriver, BrokerKind } from '../driver';

/** What a connection gives a driver beyond its URL: the host's connection fields (secrets already unsealed) or plugin env. */
export interface ConnectionOptions {
  username?: string;
  password?: string;
  tls?: boolean;
  /** Channel-name prefix (default `landflow`). */
  prefix?: string;
  /** Driver-specific fields the module declares in `fields` (a Pub/Sub project id, an SQS region). */
  [field: string]: unknown;
}

/** One extra connection field a driver needs beyond url/username/password/tls; Settings → Transports renders it. */
export interface DriverField {
  name: string;
  label: string;
  type: 'string' | 'password' | 'boolean' | 'number';
  required?: boolean;
  placeholder?: string;
  hint?: string;
}

export interface DriverModule<C extends BrokerConfig = BrokerConfig> {
  readonly kind: BrokerKind;
  /** Display name (`Kafka`, `RabbitMQ (AMQP 0-9-1)`). */
  readonly label: string;
  /** The same object every driver from `create()` reports. */
  readonly capabilities: BrokerCapabilities;
  /** Fields beyond url/username/password/tls, if any. */
  readonly fields?: DriverField[];
  /** An example URL for forms and docs (`kafka://broker-1:9092,broker-2:9092`). */
  readonly exampleUrl: string;
  /** A new, unconnected driver. */
  create(): BrokerDriver<C>;
  /** The driver config for a connection; throws a readable `Error` for a malformed URL or a missing required field. */
  configFrom(connectionId: string, url: string, options?: ConnectionOptions): C;
}

/**
 * A broker a plugin serves on, as the SDK's `serve({ brokers: [...] })` takes it. Each driver module exports a helper
 * that builds one (`kafka({ brokers: ['127.0.0.1:59092'] })`, `nats({ servers: 'nats://127.0.0.1:54222' })`); the
 * `connectionId` defaults to `env-<kind>`, the id the host gives the connection it reads from `LANDFLOW_TRANSPORT_<KIND>_URL`.
 */
export interface BrokerTarget<C extends BrokerConfig = BrokerConfig> {
  readonly kind: BrokerKind;
  /** A new, unconnected driver for this broker. */
  driver(): BrokerDriver<C>;
  readonly config: C;
}

type Loader = () => Promise<{ default: DriverModule<any> }>;

/** Known driver modules by kind. Keep the import paths literal. */
const LOADERS: Partial<Record<BrokerKind, Loader>> = {
  kafka: () => import('./kafka/index'),
  amqp: () => import('./amqp/index'),
  nats: () => import('./nats/index'),
  jetstream: () => import('./nats/jetstream'),
  valkey: () => import('./valkey/index'),
  sqs: () => import('./sqs/index'),
  pubsub: () => import('./pubsub/index'),
  pulsar: () => import('./pulsar/index'),
  servicebus: () => import('./servicebus/index'),
  mqtt: () => import('./mqtt/index'),
  amqp1: () => import('./amqp1/index'),
};

/** Kinds that have a driver module in this build. */
export const availableDriverKinds = (): BrokerKind[] => Object.keys(LOADERS);

const cache = new Map<string, Promise<DriverModule<any>>>();

/** The driver module for a kind, or undefined when this build has none. A rejected import is not cached. */
export async function loadDriverModule(kind: BrokerKind): Promise<DriverModule | undefined> {
  const loader = LOADERS[kind];
  if (!loader) return undefined;
  let pending = cache.get(kind);
  if (!pending) {
    pending = loader().then((m) => m.default);
    cache.set(kind, pending);
    pending.catch(() => cache.delete(kind));
  }
  return pending;
}
