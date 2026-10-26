/**
 * One-call plugin bootstrap:
 *
 *   await serve(plugin, { http: 7101, grpc: 7201 });
 *
 * Sets up telemetry (traces, metrics, JSON logs; see docs/observability.md),
 * builds one dispatcher, starts the requested faces (HTTP with the MCP face at
 * `/mcp`, gRPC, brokers, and any other `TransportBinding`), announces every
 * endpoint to the Landflow registry with the `transports` / `maxConcurrency`
 * hints, heartbeats, and withdraws cleanly on SIGINT/SIGTERM.
 *
 * Environment: LANDFLOW_HTTP_PORT, LANDFLOW_GRPC_PORT (ports), LANDFLOW_TRANSPORTS
 * (which faces start, e.g. `http,grpc,kafka`; default: every face given), LANDFLOW_MAX_CONCURRENCY,
 * LANDFLOW_REGISTRY_URL (`off` to disable), LANDFLOW_ADVERTISE_HOST; brokers: LANDFLOW_<KIND>_URL (+ `_USERNAME`,
 * `_PASSWORD`, `_TLS`, `_PREFIX`) and LANDFLOW_TRANSPORT_SECRET (else LANDFLOW_REGISTRY_SECRET); MCP: LANDFLOW_MCP
 * (`on`, `off`, `stdio`), LANDFLOW_MCP_TOKEN, LANDFLOW_MCP_CREDENTIALS, or the `--mcp-stdio` flag.
 */
import type { JsonObject } from '@landflow/protocol';
import type { BrokerTarget } from '@landflow/transports/drivers';
import { startAnnouncer, type Announcer } from './announce';
import { parseTransportList, type BindingContext, type BindingInfo, type TransportBinding, type TransportHints } from './binding';
import { createDispatcher, type Dispatcher } from './dispatcher';
import type { McpFace } from './mcp';
import type { IPlugin } from './node';
import { setTelemetry, type Telemetry } from './otel';
import { createTelemetry } from './telemetry';

/**
 * A broker face (docs/transports.md "Generic messaging"): a `BrokerTarget` from a driver module of `@landflow/transports`
 * (`kafka({ brokers })`, `nats({ servers })`, `amqp({ url })`, `valkey({ url })`…), which `serve()` wraps in the messaging
 * binding, or a ready `TransportBinding`.
 */
export type BrokerBinding = BrokerTarget | TransportBinding;

/** The MCP face (docs/transports.md "MCP", docs/protocol.md §15.2): on by default at `/mcp` on the HTTP port. */
export interface McpOptions {
  /** `false` turns the face off (env LANDFLOW_MCP=off). Default on, at `/mcp` on the HTTP port. */
  enabled?: boolean;
  /** Streamable HTTP path on the HTTP port. Default `/mcp`. */
  path?: string;
  /** Serve MCP over stdio instead of everything else (`--mcp-stdio`, env LANDFLOW_MCP=stdio). */
  stdio?: boolean;
  /** Bearer token callers must send (env LANDFLOW_MCP_TOKEN); required unless the HTTP port only listens on loopback. */
  token?: string;
  /** Credentials for the tools by local credential type (env LANDFLOW_MCP_CREDENTIALS: a JSON file path or inline JSON). */
  credentials?: Record<string, JsonObject>;
}

export interface ServeOptions {
  /** HTTP port (env LANDFLOW_HTTP_PORT overrides). */
  http?: number;
  /** Host the HTTP and gRPC servers listen on (default 0.0.0.0). On loopback (`127.0.0.1`) the MCP face needs no token. */
  host?: string;
  /** gRPC port (env LANDFLOW_GRPC_PORT overrides). */
  grpc?: number;
  /** Registry URL; `false` or env LANDFLOW_REGISTRY_URL=off disables announcing. */
  registryUrl?: string | false;
  /** Host name put into announced endpoints (env LANDFLOW_ADVERTISE_HOST). */
  advertiseHost?: string;
  /** Use this telemetry instead of building one from the environment. */
  telemetry?: Telemetry;
  /** More faces: your own `TransportBinding`s. One per kind. */
  bindings?: TransportBinding[];
  /**
   * Most calls running node code at once, across every face (env LANDFLOW_MAX_CONCURRENCY). Beyond it calls wait, and
   * past as many waiting again they are refused (HTTP 429, gRPC RESOURCE_EXHAUSTED). Announced as a manifest hint so the
   * host can spread load. Default: unlimited (brokers then consume with the protocol's default of 16).
   */
  maxConcurrency?: number;
  /** Broker faces: `BrokerTarget`s from `@landflow/transports/<kind>` (or ready bindings). Kinds named in LANDFLOW_TRANSPORTS with a LANDFLOW_<KIND>_URL are added. */
  brokers?: BrokerBinding[];
  /** The MCP face; `false` turns it off. */
  mcp?: McpOptions | false;
}

export interface ServeResult {
  /** Every announced endpoint, in start order. */
  endpoints: string[];
  telemetry: Telemetry;
  dispatcher: Dispatcher;
  /** The kinds that started, in start order (also the `transports` hint); includes `mcp` when the MCP face is on. */
  transports: string[];
  /** Present when announcing is on. */
  announcer?: Announcer;
  /** The MCP face, when it is on (its `tools` as listed). */
  mcp?: McpFace;
  stop(): Promise<void>;
}

const isBinding = (value: unknown): value is TransportBinding =>
  typeof value === 'object' && value !== null && typeof (value as TransportBinding).start === 'function' && typeof (value as TransportBinding).stop === 'function';

const isTarget = (value: unknown): value is BrokerTarget =>
  typeof value === 'object' && value !== null && typeof (value as BrokerTarget).driver === 'function' && typeof (value as BrokerTarget).kind === 'string' && typeof (value as BrokerTarget).config === 'object';

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
  const tag = `${plugin.info.id}@${plugin.info.version}`;

  const mcpModule = await import('./mcp');
  const mcpMode = mcpModule.mcpMode(options.mcp);
  const mcpOptions = options.mcp || {};
  const mcpToken = env[mcpModule.MCP_TOKEN_ENV] || mcpOptions.token;
  const mcpCredentials = mcpOptions.credentials ?? mcpModule.loadMcpCredentials();

  // stdio: MCP on stdin/stdout and nothing else (no HTTP, no gRPC, no brokers, no announce); the process log goes to stderr.
  if (mcpMode === 'stdio') {
    const telemetry =
      options.telemetry ??
      (await createTelemetry({
        pluginId: plugin.info.id,
        pluginVersion: plugin.info.version,
        language: plugin.info.language,
        registerGlobal: true,
        logWriter: (line) => void process.stderr.write(`${line}\n`),
      }));
    setTelemetry(telemetry);
    const log = telemetry.logger.child({ 'landflow.plugin.id': plugin.info.id, 'landflow.transport': 'mcp' });
    const hints: TransportHints = { transports: ['mcp'], ...(maxConcurrency && { maxConcurrency }) };
    const dispatcher = createDispatcher(plugin, { telemetry, maxConcurrency, hints });
    const face = mcpModule.createMcpFace({ dispatcher, manifest: dispatcher.manifest, telemetry, logger: log, loopback: true, credentials: mcpCredentials });
    const handle = await mcpModule.serveMcpStdio(face, { logger: log });
    log.info(`${tag} MCP on stdio: ${face.tools.length} tool${face.tools.length === 1 ? '' : 's'}`, { 'landflow.transports': 'mcp' });
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await handle.close();
      await dispatcher.drain();
      await face.close();
      await telemetry.shutdown();
    };
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void stop().then(() => process.exit(0)));
    return { endpoints: [], telemetry, dispatcher, transports: ['mcp'], mcp: face, stop };
  }

  // Every face we could start, keyed by kind; LANDFLOW_TRANSPORTS then picks among them.
  const available = new Map<string, TransportBinding>();
  const offer = (binding: TransportBinding) => {
    if (available.has(binding.kind)) throw new Error(`serve(): two bindings of kind "${binding.kind}"`);
    available.set(binding.kind, binding);
  };
  // The MCP face needs a token unless the HTTP port listens on loopback only; without one the face stays off (the rest
  // of the plugin still serves) and a clear error line says why.
  const loopback = mcpModule.isLoopbackHost(options.host);
  const mcpRefused =
    mcpMode === 'http' && httpPort && !mcpToken && !loopback
      ? `MCP face not started: ${mcpOptions.path ?? mcpModule.DEFAULT_MCP_PATH} on ${options.host ?? '0.0.0.0'}:${httpPort} is not loopback and no token is set; set ${mcpModule.MCP_TOKEN_ENV}, listen on 127.0.0.1 (host: '127.0.0.1'), or turn it off with ${mcpModule.MCP_ENV}=off`
      : undefined;
  const withMcp = mcpMode === 'http' && Boolean(httpPort) && !mcpRefused;
  let httpFace: (TransportBinding & { readonly mcp: McpFace | undefined }) | undefined;
  if (httpPort) {
    httpFace = (await import('./http')).httpBinding({
      port: httpPort,
      host: options.host,
      ...(withMcp && { mcp: { path: mcpOptions.path, token: mcpToken, credentials: mcpCredentials } }),
    });
    offer(httpFace);
  }
  if (grpcPort) offer((await import('./grpc')).grpcBinding({ port: grpcPort, host: options.host }));
  for (const binding of options.bindings ?? []) {
    if (!isBinding(binding)) throw new Error('serve(): bindings[] entries must implement TransportBinding (kind, start, stop)');
    offer(binding);
  }

  // Broker faces: targets given in code, plus kinds LANDFLOW_TRANSPORTS names with a LANDFLOW_<KIND>_URL. The messaging
  // module (and with it @landflow/transports) loads only when a broker is in play; drivers load inside the target.
  const targets: BrokerTarget[] = [];
  for (const broker of options.brokers ?? []) {
    if (isBinding(broker)) offer(broker);
    else if (isTarget(broker)) targets.push(broker);
    else throw new Error('serve(): brokers[] entries must be BrokerTargets (kind, driver(), config) from @landflow/transports/<kind>, or TransportBindings');
  }
  const selected = parseTransportList(env.LANDFLOW_TRANSPORTS);
  const messaging = targets.length || selected?.some((kind) => !available.has(kind) && kind !== 'mcp') ? await import('./messaging') : undefined;
  for (const kind of selected ?? []) {
    if (available.has(kind) || kind === 'mcp' || targets.some((target) => target.kind === kind) || !messaging) continue;
    if (kind === 'http' || kind === 'grpc') throw new Error(`serve(): LANDFLOW_TRANSPORTS names "${kind}" but no ${kind.toUpperCase()} port was given`);
    const target = await messaging.brokerTargetFromEnv(kind);
    if (target) targets.push(target);
    else if (messaging.BROKER_KINDS.includes(kind)) throw new Error(`serve(): LANDFLOW_TRANSPORTS names "${kind}" but ${messaging.brokerUrlEnv(kind)} is not set`);
    else throw new Error(`serve(): LANDFLOW_TRANSPORTS names "${kind}", which no binding provides`);
  }
  if (targets.length && messaging) {
    // Fail before any face starts when the shared secret is missing (MissingSecretError says which variable to set).
    const { Keyring } = await import('@landflow/transports');
    const keyring = Keyring.fromEnv();
    for (const target of targets) offer(messaging.messagingBinding(target, { keyring }));
  }

  const toStart: TransportBinding[] = [];
  for (const kind of selected ?? [...available.keys()]) {
    const binding = available.get(kind);
    if (binding) toStart.push(binding);
    else if (kind === 'mcp') {
      if (!withMcp) throw new Error(`serve(): LANDFLOW_TRANSPORTS names "mcp" but the MCP face is ${mcpMode === 'off' ? 'off (LANDFLOW_MCP=off)' : mcpRefused ?? 'served on the HTTP port, and no HTTP port was given'}`);
    } else throw new Error(`serve(): LANDFLOW_TRANSPORTS names "${kind}", which no binding provides`);
  }
  if (!toStart.length) throw new Error('serve(): enable at least one transport (http or grpc port, a broker, or a binding)');

  const telemetry =
    options.telemetry ??
    (await createTelemetry({ pluginId: plugin.info.id, pluginVersion: plugin.info.version, language: plugin.info.language, registerGlobal: true }));
  setTelemetry(telemetry);
  const log = telemetry.logger.child({ 'landflow.plugin.id': plugin.info.id });
  if (mcpRefused) log.error(`${tag} ${mcpRefused}`, { 'landflow.transport': 'mcp' });

  const transports = toStart.map((binding) => binding.kind);
  if (withMcp && toStart.includes(httpFace!)) transports.push('mcp');
  const hints: TransportHints = { transports, ...(maxConcurrency && { maxConcurrency }) };
  const dispatcher = createDispatcher(plugin, { telemetry, maxConcurrency, hints });

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
  const mcp = httpFace?.mcp;
  log.info(`${tag} nodes: ${plugin.nodes.map((n) => n.description.name).join(', ')}`, {
    'landflow.telemetry.enabled': telemetry.enabled,
    'landflow.transports': transports.join(','),
    ...(maxConcurrency && { 'landflow.max_concurrency': maxConcurrency }),
    ...(started.some((binding) => binding.kind === 'http') && { 'landflow.metrics.path': '/metrics' }),
    ...(mcp && { 'landflow.mcp.tools': mcp.tools.length }),
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

  return { endpoints, telemetry, dispatcher, transports, announcer, ...(mcp && { mcp }), stop };
}
