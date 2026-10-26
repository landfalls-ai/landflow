/**
 * Transport providers (docs/transports.md, "Host side"): one per transport kind, each able to make a PluginClient for
 * an endpoint of its kind and to say what it can carry. The direct kinds (`http`, `grpc`: direct.ts) are registered at
 * start; broker kinds register a provider when their driver lands (`@landflow/transports`, the messaging host side),
 * and until then a kind is "known but not installed": Settings → Transports lists it, connections can be saved for it,
 * and Test answers "No driver for <kind> yet".
 */
import { BROKER_TRANSPORT_KINDS, parseEndpoint, tryParseEndpoint } from '@landflow/protocol';
import { transportLabel, type ConnectionField, type TransportCapabilities, type TransportConnectionCheck, type TransportKind, type TransportKindInfo } from '../../shared/transports';
import type { PluginClient } from '../plugins/clients';
import { singleton } from '../singleton';
import { grpcProvider, httpProvider } from './direct';

export type { TransportCapabilities, TransportKind };

/** A broker connection as a provider receives it: the saved config with its secrets opened (connections.ts). */
export interface TransportConnectionConfig {
  id: string;
  kind: TransportKind;
  /** Non-secret fields (`url`, `username`, `tls`…). */
  config: Record<string, string | boolean>;
  /** Secret fields, decrypted (`password`, `token`…). */
  secrets: Record<string, string>;
}

export interface ProviderHealth {
  ok: boolean;
  message?: string;
}

/** The result of `test(connection)`: whether a round trip worked, and what the broker said about itself. */
export type ConnectionTestResult = Omit<TransportConnectionCheck, 'at'>;

/**
 * The host side of one transport kind. Direct providers connect to the plugin's endpoint; broker providers publish
 * through a connection and need one for every endpoint (`<kind>://<connectionId>/<pluginId>`).
 */
export interface TransportProvider {
  readonly kind: TransportKind;
  readonly label: string;
  /** The host connects to the plugin (no connection rows); false for brokers. */
  readonly direct: boolean;
  /** What the kind can carry: the selector's capability inputs (size limits, delivery modes, a latency prior). */
  readonly capabilities: TransportCapabilities;
  /** The connection fields Settings → Transports shows for this kind (brokers); default: url, username, password, tls. */
  readonly fields?: ConnectionField[];
  /** A client for one endpoint of this kind. Brokered kinds get the connection the endpoint names. */
  createClient(endpoint: string, connection?: TransportConnectionConfig): PluginClient;
  /** The provider's own state (a direct provider is always ready; a broker provider reports its driver and connections). */
  health(): ProviderHealth;
  /** Brokers: connect with this config, make one round trip, close. Absent on direct providers. */
  test?(connection: TransportConnectionConfig): Promise<ConnectionTestResult>;
}

/** An example address per broker kind, for the URL field's placeholder (the broker's usual port). */
const EXAMPLE_URLS: Record<string, string> = {
  kafka: 'kafka://broker-1:9092,broker-2:9092',
  amqp: 'amqp://rabbitmq:5672/landflow',
  nats: 'nats://nats:4222',
  valkey: 'redis://valkey:6379/0',
  mqtt: 'mqtt://mosquitto:1883',
  sqs: 'https://sqs.eu-west-1.amazonaws.com',
  pubsub: 'pubsub://my-project',
  servicebus: 'sb://my-namespace.servicebus.windows.net',
  amqp1: 'amqp://artemis:5672',
  pulsar: 'pulsar://pulsar:6650',
};

/** The fields of a broker connection when its provider names none. */
export const connectionFieldsFor = (kind: TransportKind): ConnectionField[] => [
  { name: 'url', label: 'URL', type: 'string', required: true, placeholder: EXAMPLE_URLS[kind] ?? `${kind}://host:port`, hint: 'The broker’s address (a comma-separated list where the client takes one); credentials go in the fields below, not in the URL.' },
  { name: 'username', label: 'Username', type: 'string' },
  { name: 'password', label: 'Password', type: 'password' },
  { name: 'tls', label: 'TLS', type: 'boolean', hint: 'Recommended for any broker that isn’t on this host.' },
];

/** The transport kind an endpoint names: `http`/`https` → `http`, `grpc`, or `<kind>` of `<kind>://<connection>/<plugin>`. Throws on malformed input. */
export const endpointKind = (endpoint: string): TransportKind => parseEndpoint(endpoint).kind;

/** A brokered endpoint's parts (`kafka://kafka-main/twilio`), or undefined for a direct or malformed one. */
export function brokeredEndpoint(endpoint: string): { kind: TransportKind; connectionId: string; pluginId: string } | undefined {
  const parsed = tryParseEndpoint(endpoint);
  return parsed?.brokered ? { kind: parsed.kind, connectionId: parsed.connectionId, pluginId: parsed.pluginId } : undefined;
}

export class TransportProviderRegistry {
  private readonly providers = new Map<TransportKind, TransportProvider>();

  /** Register (or replace) the provider of a kind; returns a function that removes it. */
  register(provider: TransportProvider): () => void {
    this.providers.set(provider.kind, provider);
    return () => {
      if (this.providers.get(provider.kind) === provider) this.providers.delete(provider.kind);
    };
  }

  get(kind: TransportKind): TransportProvider | undefined {
    return this.providers.get(kind);
  }

  list(): TransportProvider[] {
    return [...this.providers.values()];
  }

  /** The provider for an endpoint's kind; throws when none is registered. */
  forEndpoint(endpoint: string): TransportProvider {
    const kind = endpointKind(endpoint);
    const provider = this.providers.get(kind);
    if (!provider) throw new Error(`No transport provider for "${kind}" (${endpoint}): no driver for ${transportLabel(kind)} yet`);
    return provider;
  }

  /** A client for an endpoint, from its kind's provider. */
  createClient(endpoint: string, connection?: TransportConnectionConfig): PluginClient {
    return this.forEndpoint(endpoint).createClient(endpoint, connection);
  }

  /** The kind's fields for the connection form. */
  fieldsOf(kind: TransportKind): ConnectionField[] {
    return this.providers.get(kind)?.fields ?? connectionFieldsFor(kind);
  }

  /** Every kind the host knows: the registered providers, then the spec's broker kinds that have no driver yet. */
  kinds(): TransportKindInfo[] {
    const known: TransportKind[] = [...new Set<TransportKind>([...this.providers.keys(), ...BROKER_TRANSPORT_KINDS])];
    return known.map((kind) => {
      const provider = this.providers.get(kind);
      return {
        kind,
        label: provider?.label ?? transportLabel(kind),
        direct: provider?.direct ?? false,
        installed: Boolean(provider),
        ...(provider && { capabilities: provider.capabilities }),
        fields: provider?.direct ? [] : this.fieldsOf(kind),
      };
    });
  }
}

/** The host's providers, with the direct kinds registered. */
export const transportProviders = singleton('transport-providers', () => {
  const registry = new TransportProviderRegistry();
  registry.register(httpProvider);
  registry.register(grpcProvider);
  return registry;
});
