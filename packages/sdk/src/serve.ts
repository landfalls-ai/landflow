/**
 * One-call plugin bootstrap:
 *
 *   await serve(plugin, { http: 7101, grpc: 7201 });
 *
 * Sets up telemetry (traces, metrics, JSON logs; see docs/observability.md),
 * starts the requested transports, announces every endpoint to the Landflow
 * registry, heartbeats, and withdraws cleanly on SIGINT/SIGTERM.
 */
import { startAnnouncer, type Announcer } from './announce';
import type { IPlugin } from './node';
import { setTelemetry, type Telemetry } from './otel';
import { createTelemetry } from './telemetry';

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
}

export async function serve(plugin: IPlugin, options: ServeOptions = {}) {
  const env = process.env;
  const httpPort = env.LANDFLOW_HTTP_PORT ? Number(env.LANDFLOW_HTTP_PORT) : options.http;
  const grpcPort = env.LANDFLOW_GRPC_PORT ? Number(env.LANDFLOW_GRPC_PORT) : options.grpc;
  const advertise = env.LANDFLOW_ADVERTISE_HOST ?? options.advertiseHost ?? '127.0.0.1';
  const registryEnv = env.LANDFLOW_REGISTRY_URL;
  const registryUrl =
    registryEnv === 'off' || options.registryUrl === false
      ? undefined
      : (registryEnv ?? options.registryUrl ?? 'http://127.0.0.1:3000');

  if (!httpPort && !grpcPort) throw new Error('serve(): enable at least one transport (http or grpc port)');

  const telemetry =
    options.telemetry ??
    (await createTelemetry({ pluginId: plugin.info.id, pluginVersion: plugin.info.version, language: plugin.info.language, registerGlobal: true }));
  setTelemetry(telemetry);
  const log = telemetry.logger.child({ 'landflow.plugin.id': plugin.info.id });

  const endpoints: string[] = [];
  const closers: Array<() => Promise<void>> = [];
  const tag = `${plugin.info.id}@${plugin.info.version}`;

  if (httpPort) {
    const { serveHttp } = await import('./http');
    const server = await serveHttp(plugin, { port: httpPort, telemetry });
    endpoints.push(`http://${advertise}:${httpPort}`);
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    log.info(`${tag} HTTP listening on :${httpPort}`, { 'server.port': httpPort, 'landflow.transport': 'http' });
  }
  if (grpcPort) {
    const { serveGrpc } = await import('./grpc');
    const server = await serveGrpc(plugin, { port: grpcPort, telemetry });
    endpoints.push(`grpc://${advertise}:${grpcPort}`);
    closers.push(() => new Promise<void>((resolve) => server.tryShutdown(() => resolve())));
    log.info(`${tag} gRPC listening on :${grpcPort}`, { 'server.port': grpcPort, 'landflow.transport': 'grpc' });
  }
  log.info(`${tag} nodes: ${plugin.nodes.map((n) => n.description.name).join(', ')}`, {
    'landflow.telemetry.enabled': telemetry.enabled,
    ...(httpPort && { 'landflow.metrics.path': '/metrics' }),
  });

  let announcer: Announcer | undefined;
  if (registryUrl) {
    announcer = await startAnnouncer({
      registryUrl,
      endpoints,
      pluginId: plugin.info.id,
      version: plugin.info.version,
      log: (message) => log.info(message),
    });
  }

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    log.info(`${tag} shutting down`);
    await announcer?.stop();
    await Promise.allSettled(closers.map((close) => close()));
    await telemetry.shutdown();
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void stop().then(() => process.exit(0)));
  }

  return { endpoints, telemetry, stop };
}
