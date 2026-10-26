/**
 * `pnpm worker` (queue mode): a process that only runs executions. It opens the same database as the mains, connects
 * to the plugins they registered, and takes jobs from the Valkey stream (cluster/worker.ts). No UI, API or webhooks:
 * just a health and metrics endpoint (LANDFLOW_WORKER_PORT, default 5690: `/healthz`, `/metrics`).
 *
 * SIGTERM / SIGINT: stop taking jobs, let runs finish for LANDFLOW_WORKER_SHUTDOWN_SECONDS, put the rest back in the
 * queue (another worker continues them from their last checkpoint), flush the database and exit. A second signal
 * exits at once.
 *
 * Run with tsx (it resolves the `@/` imports through tsconfig.json); the Docker image ships it bundled (worker.mjs).
 */

// Before any module reads the environment (they are imported below, after this).
process.env.LANDFLOW_ROLE = 'worker';
process.env.OTEL_SERVICE_NAME ||= 'landflow-worker';

async function main() {
  const { startTelemetry } = await import('../telemetry/sdk');
  startTelemetry();
  const { logger } = await import('../telemetry/logger');
  const { clusterState } = await import('./state');
  const { checkClusterConfig, ClusterConfigError } = await import('./config');
  const { config } = clusterState();
  try {
    checkClusterConfig(config);
  } catch (error) {
    if (error instanceof ClusterConfigError) {
      logger.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const { openDatabase, closeDatabase } = await import('../db');
  await openDatabase();
  const { registry } = await import('../plugins/registry');
  const { corePlugin } = await import('../nodes');
  const { observePluginsOnline } = await import('../telemetry');
  registry.registerBuiltin(corePlugin);
  registry.start();
  observePluginsOnline(() => registry.list());
  // Workers open the broker connections too and choose transports for themselves (own hostInstanceId and reply channel).
  const { registerBrokerProviders } = await import('../transports/broker-provider');
  const { brokerConnections } = await import('../transports/brokers');
  await registerBrokerProviders();
  void brokerConnections.start(registry).catch((error: Error) => logger.warn('broker connections did not start', { error: error.message }));
  const seeds = (process.env.LANDFLOW_PLUGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  await Promise.allSettled(seeds.map((endpoint) => registry.addEndpoint(endpoint, 'static')));
  if ((process.env.LANDFLOW_PLUGIN_DISCOVERY ?? '').split(',').some((mode) => mode.trim().toLowerCase() === 'kubernetes')) {
    void import('../plugins/kubernetes').then((k8s) => k8s.startKubernetesDiscovery());
  }
  // Files go with their execution (a run that isn't kept is deleted here); online evaluations grade what runs here.
  const { startBinaryMaintenance } = await import('../binary/access');
  startBinaryMaintenance();
  const { startOnlineEvaluations } = await import('../evaluations/online');
  startOnlineEvaluations();

  const { startCluster, stopCluster } = await import('./index');
  try {
    await startCluster({ role: 'worker' });
  } catch (error) {
    logger.error((error as Error).message);
    await closeDatabase().catch(() => {});
    process.exit(1);
  }
  logger.info('worker ready', { 'landflow.cluster.instance': config.instanceId, 'landflow.worker.concurrency': config.workerConcurrency, 'landflow.worker.port': config.workerPort });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) {
      logger.warn('worker: second signal, exiting now', { signal });
      process.exit(1);
    }
    stopping = true;
    logger.info('worker: stopping', { signal, 'landflow.jobs.active': clusterState().activeJobs.size });
    try {
      await clusterState().worker?.stop(config.shutdownMs);
      await brokerConnections.stop();
      await stopCluster();
      await closeDatabase();
      const { startTelemetry: telemetry } = await import('../telemetry/sdk');
      await telemetry().shutdown?.();
    } catch (error) {
      logger.warn('worker: shutdown error', { error: (error as Error).message });
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.warn('worker: unhandled rejection', { error: reason instanceof Error ? reason.message : String(reason) }));
}

main().catch((error) => {
  console.error('worker failed to start:', error);
  process.exit(1);
});
