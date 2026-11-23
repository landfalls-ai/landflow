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

  // Signal handlers before the boot, as on the main: a SIGTERM while a later step waits still runs the shutdown steps
  // registered once the database opened (flush, release the lease) instead of the default kill.
  const { installProcessHandlers } = await import('../lifecycle');
  installProcessHandlers({ role: 'worker', deadlineMs: config.shutdownMs + 10_000 });

  // The one service table (lib/server/runtime.ts): config check, database, registry, brokers, seeds, discovery, binary
  // maintenance, online evaluations and, last, the cluster runtime that starts taking jobs.
  const { startRuntime } = await import('../runtime');
  // Hold the event loop while booting: the Valkey client's reconnect and command timers are unref'd, so with Valkey
  // unreachable nothing else keeps the process alive and it would exit 0 silently before the ping times out.
  const hold = setInterval(() => {}, 60_000);
  try {
    await startRuntime({ role: 'worker' });
  } catch (error) {
    logger.error('worker failed to start', { error: (error as Error).message });
    const { closeDatabase } = await import('../db');
    await closeDatabase().catch(() => {});
    process.exit(1);
  } finally {
    clearInterval(hold);
  }
  logger.info('worker ready', { 'landflow.cluster.instance': config.instanceId, 'landflow.worker.concurrency': config.workerConcurrency, 'landflow.worker.port': config.workerPort });
}

main().catch((error) => {
  console.error('worker failed to start:', error);
  process.exit(1);
});
