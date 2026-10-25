/**
 * Idempotent server bootstrap: built-in plugin, static seeds, gRPC registry,
 * lease reaper, an initial network scan, the scheduler and agent triggers. Called from
 * instrumentation.ts at startup and defensively from API routes.
 */
import { agentTriggers } from './agents/triggers';
import { marketplace } from './marketplace/service';
import { startDataMaintenance } from './maintenance';
import { corePlugin } from './nodes';
import { registry } from './plugins/registry';
import { startRegistryGrpcServer } from './plugins/registry-grpc';
import { scheduler } from './scheduler';
import { seedWorkflows } from './seed';
import { singleton } from './singleton';
import { logger, observePluginsOnline } from './telemetry';

export function ensureBootstrapped(): Promise<void> {
  return singleton('bootstrap', async () => {
    registry.registerBuiltin(corePlugin);
    registry.start();
    observePluginsOnline(() => registry.list());
    seedWorkflows();
    // Insights backfill (first boot) and execution retention, before anything can start a run.
    startDataMaintenance();
    scheduler.start();
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
