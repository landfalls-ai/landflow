/**
 * Idempotent server bootstrap: the database (and the one-time import of the old JSON files), built-in plugin,
 * static seeds, gRPC registry, lease reaper, an initial network scan, the scheduler, waiting executions' timers,
 * recovery of executions a restart interrupted, automatic retries, queued runs and agent triggers. Called from
 * instrumentation.ts at startup and defensively from API routes.
 */
import { agentTriggers } from './agents/triggers';
import { startBinaryMaintenance } from './binary/access';
import { marketplace } from './marketplace/service';
import { startDataMaintenance } from './maintenance';
import { openDatabase } from './db';
import { corePlugin } from './nodes';
import { registry } from './plugins/registry';
import { retries } from './retries';
import { startRecovery } from './runner';
import { startRegistryGrpcServer } from './plugins/registry-grpc';
import { scheduler } from './scheduler';
import { seedWorkflows } from './seed';
import { singleton } from './singleton';
import { waits } from './waits';
import { logger, observePluginsOnline } from './telemetry';

export function ensureBootstrapped(): Promise<void> {
  return singleton('bootstrap', async () => {
    // SQLite opens lazily on first use; Postgres mode loads its mirror here, before anything reads the store.
    await openDatabase();
    registry.registerBuiltin(corePlugin);
    registry.start();
    observePluginsOnline(() => registry.list());
    seedWorkflows();
    // Insights backfill (first boot) and execution retention, before anything can start a run.
    startDataMaintenance();
    // Binary data goes with its execution; orphaned files are swept hourly.
    startBinaryMaintenance();
    scheduler.start();
    // Waiting executions: re-arm their timers; overdue ones resume shortly (plugins get a moment to announce).
    waits.start();
    // Runs a restart interrupted continue from their last checkpoint, then queued runs start (plugins announce first).
    startRecovery();
    retries.start();
    agentTriggers.start();
    await startRegistryGrpcServer();

    const seeds = (process.env.LANDFLOW_PLUGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    await Promise.allSettled(seeds.map((endpoint) => registry.addEndpoint(endpoint, 'static')));

    if (process.env.LANDFLOW_SCAN_ON_START !== 'false') {
      // Pick up plugins that started before the host (they keep re-announcing anyway).
      setTimeout(() => void registry.scan().catch(() => {}), 1_500).unref?.();
    }
    // Node plugins installed from a marketplace run as child processes of the host.
    marketplace.startNodePlugins();
    logger.info('host ready: registry, scheduler and discovery running');
  });
}
