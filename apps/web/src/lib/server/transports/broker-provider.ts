/**
 * Broker transports behind the provider interface (docs/transports.md "Host side"): one `TransportProvider` per broker
 * kind that has a driver module (`@landflow/transports/drivers`), registered at host start next to http and grpc by
 * `registerBrokerProviders()`. Kinds without a module stay "known but not installed".
 *
 * `BrokerPluginClient` is the `PluginClient` for one brokered endpoint `<kind>://<connectionId>/<pluginId>`: every
 * method is one `MessagingClient.call()` through the connection the endpoint names, looked up on each call so an edited
 * (reopened) connection serves the same endpoint without re-registering. Calls carry the deadline, the abort signal, the
 * trace context, the idempotency key and the delivery mode (`at-least-once` only for an Execute of a node or operation
 * the manifest marks `idempotent`; every other method may repeat), and the manifest hash the host knows. Messaging
 * errors pass through untouched so the registry can tell a provably undelivered call (safe to fail over) from one that
 * may have run. Client spans add the OpenTelemetry messaging attributes to the `plugin.rpc` span.
 */
import {
  parseManifest,
  type ExecuteRequest,
  type ExecuteResponse,
  type HealthResponse,
  type LoadOptionsRequest,
  type PluginManifest,
  type PropertyOption,
  type TestCredentialsRequest,
  type TestCredentialsResponse,
  type WebhookMethodRequest,
  type WebhookMethodResponse,
  type WebhookRequest,
  type WebhookResponse,
} from '@landflow/protocol';
import { idempotencyFromManifest, UndeliverableError, type CallOptions, type DeliveryMode, type Method, type MessagingClient, type RequestBody, type ResponseBody } from '@landflow/transports';
import type { DriverModule } from '@landflow/transports/drivers';
import type { ConnectionField, TransportCapabilities } from '../../shared/transports';
import { EXECUTE_TIMEOUT_MS, type PluginClient } from '../plugins/clients';
import { tracePluginRpc, type RpcMethod } from '../telemetry';
import { brokerConnections, driverModules, roundTrip, type BrokerConnectionManager } from './brokers';
import { brokeredEndpoint, connectionFieldsFor, transportProviders, type ConnectionTestResult, type TransportConnectionConfig, type TransportProvider, type TransportProviderRegistry } from './provider';

/** `messaging.system` values (OpenTelemetry semantic conventions) for the kinds that have one; other kinds use their name. */
const MESSAGING_SYSTEMS: Record<string, string> = { amqp: 'rabbitmq', valkey: 'redis', sqs: 'aws_sqs', pubsub: 'gcp_pubsub', amqp1: 'activemq' };

/** Per-method deadlines, as the direct clients use them. */
const TIMEOUTS: Record<Method, number> = { GetManifest: 10_000, Execute: EXECUTE_TIMEOUT_MS, LoadOptions: 5_000, TestCredentials: 30_000, Health: 2_000, WebhookMethod: 30_000, ReceiveWebhook: 30_000 };

export class BrokerPluginClient implements PluginClient {
  readonly transport: string;
  pluginId: string;
  private readonly connectionId: string;
  private manifestHash?: string;
  private isIdempotent?: (request: ExecuteRequest) => boolean;

  constructor(
    readonly endpoint: string,
    private readonly manager: BrokerConnectionManager = brokerConnections,
  ) {
    const parsed = brokeredEndpoint(endpoint);
    if (!parsed) throw new Error(`"${endpoint}" is not a brokered endpoint (<kind>://<connectionId>/<pluginId>)`);
    this.transport = parsed.kind;
    this.connectionId = parsed.connectionId;
    this.pluginId = parsed.pluginId;
  }

  /** The connection's open client; provably undelivered when it is not open. */
  private client(): MessagingClient {
    const client = this.manager.clientFor(this.connectionId);
    if (!client) throw new UndeliverableError(this.manager.describe(this.connectionId), 'not_connected');
    return client;
  }

  /** The OpenTelemetry messaging attributes of a call's client span. */
  private attributes(): Record<string, string> {
    return {
      'messaging.system': MESSAGING_SYSTEMS[this.transport] ?? this.transport,
      'messaging.destination.name': this.manager.destinationOf(this.connectionId, this.pluginId),
      'messaging.operation.type': 'send',
    };
  }

  private call<M extends Method>(method: M & RpcMethod, body: RequestBody<M>, options: Omit<CallOptions, 'deadline' | 'traceparent' | 'tracestate' | 'manifestHash'> & { timeoutMs?: number } = {}): Promise<ResponseBody<M>> {
    return tracePluginRpc(method, { system: this.transport, endpoint: this.endpoint, pluginId: this.pluginId, attributes: this.attributes() }, (carrier) => {
      const { timeoutMs, ...rest } = options;
      return this.client().call(this.pluginId, method, body, {
        ...rest,
        deadline: Date.now() + (timeoutMs ?? TIMEOUTS[method]),
        ...(carrier.traceparent && { traceparent: carrier.traceparent }),
        ...(carrier.tracestate && { tracestate: carrier.tracestate }),
        ...(this.manifestHash && { manifestHash: this.manifestHash }),
      });
    });
  }

  /**
   * Remember what the manifest reply taught: the plugin id, which nodes may repeat, and the hash **the plugin** computed
   * (`lfmanifest` on the reply; announces carry the same). The host never hashes the manifest itself for `lfmanifest`:
   * validation fills in defaults, so its own hash of the parsed manifest would not match the plugin's.
   */
  private learn(raw: unknown, hash: string | undefined): PluginManifest {
    const parsed = parseManifest(raw);
    if (!parsed.ok) throw new Error(`Invalid manifest from ${this.endpoint}: ${parsed.error}`);
    this.pluginId = parsed.manifest.plugin.id;
    this.manifestHash = hash ?? this.manager.announced(this.endpoint)?.manifestHash;
    this.isIdempotent = idempotencyFromManifest(parsed.manifest);
    return parsed.manifest;
  }

  /** GetManifest over the broker; the plugin answers whichever instance takes it. The manifest also tells which nodes may repeat. */
  manifest(): Promise<PluginManifest> {
    const attributes = this.attributes();
    return tracePluginRpc('GetManifest', { system: this.transport, endpoint: this.endpoint, pluginId: this.pluginId, attributes }, async (carrier) => {
      const reply = await this.client().invoke(this.pluginId, 'GetManifest', {}, { deadline: Date.now() + TIMEOUTS.GetManifest, ...(carrier.traceparent && { traceparent: carrier.traceparent }) });
      return this.learn(reply.body, reply.attributes.lfmanifest);
    });
  }

  /** The delivery mode of an Execute: at least once only when the node (or its operation) is marked idempotent. */
  deliveryFor(request: ExecuteRequest): DeliveryMode {
    try {
      return this.isIdempotent?.(request) ? 'at-least-once' : 'at-most-once';
    } catch {
      return 'at-most-once';
    }
  }

  execute(request: ExecuteRequest, signal?: AbortSignal): Promise<ExecuteResponse> {
    return this.call('Execute', request, {
      signal,
      delivery: this.deliveryFor(request),
      idempotencyKey: request.idempotencyKey ?? `${request.executionId}:${request.node.id}`,
      orderingKey: request.executionId,
    });
  }

  async loadOptions(request: LoadOptionsRequest): Promise<PropertyOption[]> {
    return (await this.call('LoadOptions', request)).options;
  }

  async testCredentials(request: TestCredentialsRequest): Promise<TestCredentialsResponse> {
    const response = await this.call('TestCredentials', request);
    return { ok: Boolean(response.ok), ...(response.message && { message: response.message }) };
  }

  webhookMethod(request: WebhookMethodRequest): Promise<WebhookMethodResponse> {
    return this.call('WebhookMethod', request);
  }

  receiveWebhook(request: WebhookRequest): Promise<WebhookResponse> {
    return this.call('ReceiveWebhook', request);
  }

  /** Untraced, like the direct clients' probes. */
  async health(timeoutMs = 2_000): Promise<HealthResponse> {
    return this.client().call(this.pluginId, 'Health', {}, { timeoutMs, ...(this.manifestHash && { manifestHash: this.manifestHash }) });
  }

  /** The connection outlives the endpoint's client (the manager owns it). */
  close(): void {}
}

/** What the selector may rely on, from the driver's capabilities. */
export function capabilitiesOf(module: DriverModule): TransportCapabilities {
  const c = module.capabilities;
  return { maxMessageBytes: c.maxMessageBytes, delivery: c.nack ? ['at-most-once', 'at-least-once'] : ['at-most-once'], latency: c.latency, buffering: c.buffering };
}

/** The connection form's fields: url (with the module's example), username, password, tls, then the driver's own. */
export function fieldsOf(module: DriverModule): ConnectionField[] {
  const base = connectionFieldsFor(module.kind).map((field) => (field.name === 'url' ? { ...field, placeholder: module.exampleUrl } : field));
  const extra: ConnectionField[] = (module.fields ?? []).map((field) => ({ ...field, type: field.type === 'number' ? 'string' : field.type }));
  return [...base, ...extra.filter((field) => !base.some((b) => b.name === field.name))];
}

/** Connect with the form's config, one publish/consume round trip through a temporary channel, close. */
export async function testConnection(module: DriverModule, connection: TransportConnectionConfig): Promise<ConnectionTestResult> {
  const config = module.configFrom(connection.id, String(connection.config.url ?? ''), { ...connection.config, ...connection.secrets });
  const driver = module.create();
  try {
    await driver.connect(config);
    const result = await roundTrip(driver, config.prefix);
    return { ok: true, message: `Connected to ${module.label}${result.version ? ` ${result.version}` : ''}: round trip ${result.latencyMs} ms`, latencyMs: result.latencyMs, ...(result.version && { version: result.version }) };
  } finally {
    await driver.close().catch(() => {});
  }
}

export function createBrokerProvider(module: DriverModule, manager: BrokerConnectionManager = brokerConnections): TransportProvider {
  return {
    kind: module.kind,
    label: module.label,
    direct: false,
    capabilities: capabilitiesOf(module),
    fields: fieldsOf(module),
    createClient: (endpoint) => new BrokerPluginClient(endpoint, manager),
    health: () => manager.providerHealth(module.kind),
    test: (connection) => testConnection(module, connection),
  };
}

/**
 * Register a provider for every kind with a driver module (the package's and those registered in `driverModules`).
 * Called at host start, before connections open and before any brokered endpoint can be registered.
 */
export async function registerBrokerProviders(options: { modules?: typeof driverModules; providers?: TransportProviderRegistry; manager?: BrokerConnectionManager } = {}): Promise<TransportProvider[]> {
  const modules = options.modules ?? driverModules;
  const providers = options.providers ?? transportProviders;
  const manager = options.manager ?? brokerConnections;
  const registered: TransportProvider[] = [];
  for (const kind of modules.kinds()) {
    const module = await modules.load(kind);
    if (!module) continue;
    const provider = createBrokerProvider(module, manager);
    providers.register(provider);
    registered.push(provider);
  }
  return registered;
}
