/**
 * One-call plugin bootstrap:
 *
 *   await serve(plugin, { http: 7101, grpc: 7201 });
 *
 * Sets up telemetry (traces, metrics, JSON logs; see docs/observability.md),
 * builds one dispatcher, starts the requested faces (HTTP, gRPC, and any other
 * `TransportBinding`), announces every endpoint to the Landflow registry with
 * the `transports` / `maxConcurrency` hints, heartbeats, and withdraws cleanly
 * on SIGINT/SIGTERM.
 *
 * Environment: LANDFLOW_HTTP_PORT, LANDFLOW_GRPC_PORT (ports), LANDFLOW_TRANSPORTS
 * (which faces start, e.g. `http,grpc`; default: every face given), LANDFLOW_MAX_CONCURRENCY,
 * LANDFLOW_REGISTRY_URL (`off` to disable), LANDFLOW_ADVERTISE_HOST, LANDFLOW_MCP (next wave).
 */
import { startAnnouncer, type Announcer } from './announce';
import { parseTransportList, type BindingContext, type BindingInfo, type TransportBinding, type TransportHints } from './binding';
import { createDispatcher, type Dispatcher } from './dispatcher';
import type { IPlugin } from './node';
import { setTelemetry, type Telemetry } from './otel';
import { createTelemetry } from './telemetry';

/**
 * A broker face (docs/transports.md "Generic messaging"): a `TransportBinding` built by `@landflow/transports`
 * (`kafka({ brokers })`, `nats({ servers })`…). Placeholder until the messaging binding lands (next wave): today
 * `serve()` refuses `brokers` with a clear error. // TODO(next wave): accept the messaging bindings here.
 */
export type BrokerBinding = TransportBinding | { readonly kind: string };

/** The MCP face (docs/transports.md "MCP"). Placeholder until next wave: today it is ignored with a debug log. */
export interface McpOptions {
  /** `false` turns the face off (env LANDFLOW_MCP=off). Default on, at `/mcp` on the HTTP port. */
  enabled?: boolean;
  /** Streamable HTTP path on the HTTP port. Default `/mcp`. */
  path?: string;
  /** Also serve MCP over stdio (`--mcp-stdio`, env LANDFLOW_MCP=stdio). */
  stdio?: boolean;
  /** Bearer token callers must send (env LANDFLOW_MCP_TOKEN); required unless the HTTP port only listens on loopback. */
  token?: string;
}

export interface ServeOptions {
  /** HTTP port (env LANDFLOW_HTTP_PORT overrides). */
  http?: number;
  /** gRPC port (env LANDFLOW_GRPC_PORT overrides). */
  grpc?: number;
  /** Registry URL; `false` or env LANDFLOW_REGISTRY_URL=off disables announcing. */
  registryUrl?: string | false;
  /** Host name put into announced endpoints (env LANDFLOW_ADVERTISE_HOST). */
  advertiseHost?: string;
  /** Use this telemetry instead of building one from the environment. */
  telemetry?: Telemetry;
  /** More faces: broker bindings from `@landflow/transports`, MCP, or your own `TransportBinding`. One per kind. */
  bindings?: TransportBinding[];
  /**
   * Most calls running node code at once, across every face (env LANDFLOW_MAX_CONCURRENCY). Beyond it calls wait, and
   * past as many waiting again they are refused (HTTP 429, gRPC RESOURCE_EXHAUSTED). Announced as a manifest hint so the
   * host can spread load. Default: unlimited.
   */
  maxConcurrency?: number;
  /** Broker faces (next wave). */
  brokers?: BrokerBinding[];
  /** The MCP face (next wave); `false` turns it off. */
  mcp?: McpOptions | false;
}

export interface ServeResult {
  /** Every announced endpoint, in start order. */
  endpoints: string[];
  telemetry: Telemetry;
  dispatcher: Dispatcher;
  /** The kinds that started, in start order (also the `transports` hint). */
  transports: string[];
  /** Present when announcing is on. */
  announcer?: Announcer;
  stop(): Promise<void>;
}

const BROKER_KINDS = ['kafka', 'amqp', 'nats', 'valkey', 'redis', 'mqtt', 'sqs', 'pubsub', 'servicebus', 'amqp1', 'pulsar'];

const isBinding = (value: unknown): value is TransportBinding =>
  typeof value === 'object' && value !== null && typeof (value as TransportBinding).start === 'function' && typeof (value as TransportBinding).stop === 'function';

export async function serve(plugin: IPlugin, options: ServeOptions = {}): Promise<ServeResult> {
  const env = process.env;
  const httpPort = env.LANDFLOW_HTTP_PORT ? Number(env.LANDFLOW_HTTP_PORT) : options.http;
  const grpcPort = env.LANDFLOW_GRPC_PORT ? Number(env.LANDFLOW_GRPC_PORT) : options.grpc;
  const advertiseHost = env.LANDFLOW_ADVERTISE_HOST ?? options.advertiseHost ?? '127.0.0.1';
  const registryEnv = env.LANDFLOW_REGISTRY_URL;
  const registryUrl =
    registryEnv === 'off' || options.registryUrl === false
      ? undefined
      : (registryEnv ?? options.registryUrl ?? 'http://127.0.0.1:3000');
  const maxConcurrencyEnv = env.LANDFLOW_MAX_CONCURRENCY ? Number(env.LANDFLOW_MAX_CONCURRENCY) : undefined;
  const maxConcurrency = Number.isFinite(maxConcurrencyEnv) && maxConcurrencyEnv! > 0 ? maxConcurrencyEnv : options.maxConcurrency;

  if (options.brokers?.length) {
    // TODO(next wave): start them like any other binding (they are TransportBindings from @landflow/transports).
    const kinds = options.brokers.map((broker) => broker.kind).join(', ');
    throw new Error(`serve(): the messaging binding is not available yet (brokers: ${kinds}); it arrives with @landflow/transports`);
  }

  // Every face we could start, keyed by kind; LANDFLOW_TRANSPORTS then picks among them.
  const available = new Map<string, TransportBinding>();
  const offer = (binding: TransportBinding) => {
    if (available.has(binding.kind)) throw new Error(`serve(): two bindings of kind "${binding.kind}"`);
    available.set(binding.kind, binding);
  };
  if (httpPort) offer((await import('./http')).httpBinding({ port: httpPort }));
  if (grpcPort) offer((await import('./grpc')).grpcBinding({ port: grpcPort }));
  for (const binding of options.bindings ?? []) {
    if (!isBinding(binding)) throw new Error('serve(): bindings[] entries must implement TransportBinding (kind, start, stop)');
    offer(binding);
  }

  const selected = parseTransportList(env.LANDFLOW_TRANSPORTS);
  const toStart: TransportBinding[] = [];
  const mcpSkipped: string[] = [];
  for (const kind of selected ?? [...available.keys()]) {
    const binding = available.get(kind);
    if (binding) {
      toStart.push(binding);
      continue;
    }
    if (kind === 'mcp') {
      mcpSkipped.push(kind);
      continue;
    }
    if (kind === 'http' || kind === 'grpc') throw new Error(`serve(): LANDFLOW_TRANSPORTS names "${kind}" but no ${kind.toUpperCase()} port was given`);
    if (BROKER_KINDS.includes(kind)) throw new Error(`serve(): LANDFLOW_TRANSPORTS names "${kind}", but the messaging binding is not available yet`);
    throw new Error(`serve(): LANDFLOW_TRANSPORTS names "${kind}", which no binding provides`);
  }
  if (!toStart.length) throw new Error('serve(): enable at least one transport (http or grpc port, or a binding)');

  const telemetry =
    options.telemetry ??
    (await createTelemetry({ pluginId: plugin.info.id, pluginVersion: plugin.info.version, language: plugin.info.language, registerGlobal: true }));
  setTelemetry(telemetry);
  const log = telemetry.logger.child({ 'landflow.plugin.id': plugin.info.id });
  const tag = `${plugin.info.id}@${plugin.info.version}`;

  const transports = toStart.map((binding) => binding.kind);
  const hints: TransportHints = { transports, ...(maxConcurrency && { maxConcurrency }) };
  const dispatcher = createDispatcher(plugin, { telemetry, maxConcurrency, hints });

  const mcpEnv = env.LANDFLOW_MCP;
  if (options.mcp !== undefined || mcpEnv || mcpSkipped.length) {
    // TODO(next wave): the MCP face (/mcp on the HTTP port, --mcp-stdio).
    log.debug(`${tag} MCP face requested but not available yet; ignored`, { 'landflow.mcp.option': options.mcp === false ? 'off' : options.mcp ? 'on' : mcpEnv ?? 'transports' });
  }

  // Endpoints a binding announces before the announcer exists are kept here and go out with the first announce.
  const endpoints: string[] = [];
  const started: TransportBinding[] = [];
  let announcer: Announcer | undefined;
  const announce = (more: string[]) => {
    const fresh = more.filter((endpoint) => !endpoints.includes(endpoint));
    endpoints.push(...fresh);
    if (announcer && fresh.length) void announcer.add(fresh);
  };
  const withdraw = (gone: string[]) => {
    for (const endpoint of gone) {
      const index = endpoints.indexOf(endpoint);
      if (index >= 0) endpoints.splice(index, 1);
    }
    if (announcer && gone.length) void announcer.remove(gone);
  };

  const stopBindings = async () => {
    for (const binding of [...started].reverse()) {
      try {
        await binding.stop();
      } catch (error) {
        log.warn(`${tag} ${binding.kind} binding failed to stop`, { error, 'landflow.transport': binding.kind });
      }
    }
    started.length = 0;
  };

  for (const binding of toStart) {
    const context: BindingContext = {
      plugin,
      manifest: dispatcher.manifest,
      dispatcher,
      telemetry,
      logger: log.child({ 'landflow.transport': binding.kind }),
      advertiseHost,
      hints,
      announce,
      withdraw,
    };
    let info: BindingInfo;
    try {
      info = await binding.start(context);
    } catch (error) {
      await stopBindings();
      throw error;
    }
    started.push(binding);
    announce(info.endpoints);
    log.info(`${tag} ${info.description ?? `${binding.kind} started`}`, {
      'landflow.transport': binding.kind,
      ...(info.endpoints.length && { 'landflow.endpoints': info.endpoints.join(',') }),
    });
  }
  log.info(`${tag} nodes: ${plugin.nodes.map((n) => n.description.name).join(', ')}`, {
    'landflow.telemetry.enabled': telemetry.enabled,
    'landflow.transports': transports.join(','),
    ...(maxConcurrency && { 'landflow.max_concurrency': maxConcurrency }),
    ...(started.some((binding) => binding.kind === 'http') && { 'landflow.metrics.path': '/metrics' }),
  });

  if (registryUrl) {
    announcer = await startAnnouncer({
      registryUrl,
      endpoints,
      pluginId: plugin.info.id,
      version: plugin.info.version,
      hints,
      log: (message) => log.info(message),
    });
  }

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    log.info(`${tag} shutting down`);
    await announcer?.stop();
    await stopBindings();
    await telemetry.shutdown();
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void stop().then(() => process.exit(0)));
  }

  return { endpoints, telemetry, dispatcher, transports, announcer, stop };
}
