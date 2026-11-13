/**
 * `pnpm worker` (queue mode): a process that only runs executions. It opens the same database as the mains, connects
 * to the plugins they registered, and takes jobs from the Valkey stream (cluster/worker.ts). No UI, API or webhooks:
 * just a health and metrics endpoint (LANDFLOW_WORKER_PORT, default 5690: `/healthz`, `/metrics`).
 *
 * SIGTERM / SIGINT (lib/server/lifecycle.ts): stop taking jobs, let runs finish for LANDFLOW_WORKER_SHUTDOWN_SECONDS, put the rest back in the
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

  // The one service table (lib/server/runtime.ts): config check, database, registry, brokers, seeds, discovery, binary
  // maintenance, online evaluations and, last, the cluster runtime that starts taking jobs.
  const { startRuntime } = await import('../runtime');
  try {
    await startRuntime({ role: 'worker' });
  } catch (error) {
    logger.error((error as Error).message);
    const { closeDatabase } = await import('../db');
    await closeDatabase().catch(() => {});
    process.exit(1);
  }
  logger.info('worker ready', { 'landflow.cluster.instance': config.instanceId, 'landflow.worker.concurrency': config.workerConcurrency, 'landflow.worker.port': config.workerPort });

  const { installProcessHandlers } = await import('../lifecycle');
  installProcessHandlers({ role: 'worker', deadlineMs: config.shutdownMs + 10_000 });
}

main().catch((error) => {
  console.error('worker failed to start:', error);
  process.exit(1);
});
