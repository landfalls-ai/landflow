/**
 * Idempotent server bootstrap: the database (and the one-time import of the old JSON files), built-in plugin,
 * static seeds, gRPC registry, lease reaper, Kubernetes discovery (when on), an initial network scan, publications and app webhooks, the scheduler, waiting executions' timers,
 * recovery of executions a restart interrupted, automatic retries, queued runs and agent triggers. Called from
 * instrumentation.ts at startup and defensively from API routes.
 *
 * Queue mode (LANDFLOW_EXECUTIONS_MODE=queue, lib/server/cluster): the cluster runtime starts right after the database,
 * and the services only one main may run (`leaderService`) start on the elected leader and move with the leadership.
 * In regular mode `leaderService` starts them right there, as before.
 *
 * Failure policy: opening the database and the cluster runtime are required; a failure there marks the boot failed,
 * forgets the cached promise (a later call retries) and, under Next.js, exits so the orchestrator restarts the pod
 * instead of keeping a process that answers 500 to everything. Every other step is optional: logged, counted
 * (`landflow.process.errors{kind="service_start"}`), and the host keeps serving. The shutdown steps are registered
 * at the end (lib/server/lifecycle.ts).
 */
import { agentTriggers } from './agents/triggers';
import { alerts } from './alerts/service';
import { startAudit } from './audit/start';
import { appWebhooks } from './app-webhooks';
import { bootstrapOwnerFromEnv } from './auth/bootstrap';
import { startBinaryMaintenance } from './binary/access';
import { marketplace } from './marketplace/service';
import { mcpGatewaySync } from './mcp/gateway-sync';
import { triggerSubscriptionSweeper } from './mcp/triggers';
import { startDataMaintenance } from './maintenance';
import { closeDatabase, openDatabase } from './db';
import { startOnlineEvaluations } from './evaluations/online';
import { evaluationSchedules } from './evaluations/schedule';
import { imapIdle } from './imap-idle';
import { corePlugin } from './nodes';
import { auditHeads } from './audit/anchoring';
import { brain } from './brain';
import { startUsageTrigger } from './brain/usage-trigger';
import { startUsageListeners } from './usage/listeners';
import { registry } from './plugins/registry';
import { ensurePublications } from './publish';
import { publishSchedules } from './publish-schedule';
import { adoptUnassignedResources } from './projects/boot';
import { retries } from './retries';
import { localExecutions, startRecovery, startTriggerBuffers } from './runner';
import { clusterActive, leaderService, startCluster, stopCluster, stopLeaderServices } from './cluster';
import { triggerBuffers } from './trigger-buffers';
import { startRegistryGrpcServer } from './plugins/registry-grpc';
import { registerBrokerProviders } from './transports/broker-provider';
import { brokerConnections } from './transports/brokers';
import { scheduler } from './scheduler';
import { seedWorkflows } from './seed';
import { forgetSingleton, singleton } from './singleton';
import { waits } from './waits';
import { countProcessError, markBootFailed, markBooted, onShutdown, setBootstrapper } from './lifecycle';
import { logger, observePluginsOnline } from './telemetry';

/** Run an optional boot step: a throw or a rejection is logged and counted, and the boot goes on. */
async function optional(name: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (error) {
    logger.warn('service failed to start', { service: name, error: (error as Error).message });
    countProcessError('service_start');
  }
}

/** A required step failed: record it, let a later call retry, and under Next.js stop so the orchestrator restarts us. */
function failBoot(error: unknown): never {
  markBootFailed(error);
  forgetSingleton('bootstrap');
  logger.error('boot failed', { error });
  if (process.env.NEXT_RUNTIME === 'nodejs' && !process.env.VITEST) setImmediate(() => process.exit(1));
  throw error;
}

/** Remaining waits for local runs at shutdown: runs still in flight are recovered from their checkpoints at the next boot. */
async function waitForLocalRuns(): Promise<void> {
  while (localExecutions().length > 0) await new Promise((resolve) => setTimeout(resolve, 200));
}

function registerShutdown() {
  onShutdown('leader services', stopLeaderServices, 'services');
  // After the runs: a run in flight may still be talking over a broker.
  onShutdown('broker connections', () => brokerConnections.stop(), 'cluster');
  onShutdown('mcp gateway sync', () => mcpGatewaySync.stop(), 'services');
  onShutdown('local runs', waitForLocalRuns, 'runs');
  onShutdown('cluster', stopCluster, 'cluster');
  onShutdown('database', closeDatabase, 'storage');
  onShutdown('telemetry', async () => {
    const { startTelemetry } = await import('./telemetry/sdk');
    await startTelemetry().shutdown?.();
  }, 'telemetry');
}

export function ensureBootstrapped(): Promise<void> {
  setBootstrapper(ensureBootstrapped);
  return singleton('bootstrap', () => boot());
}

async function boot(): Promise<void> {
  try {
    // SQLite opens lazily on first use; Postgres mode loads its mirror here, before anything reads the store.
    await openDatabase();
    // Queue mode: Valkey, the relay and the leader election (refuses SQLite without LANDFLOW_QUEUE_ALLOW_SQLITE).
    await startCluster();
  } catch (error) {
    failBoot(error);
  }
  // LANDFLOW_OWNER_EMAIL / LANDFLOW_OWNER_PASSWORD: the owner, created at boot while there is no user (Docker, CI).
  await optional('owner from environment', bootstrapOwnerFromEnv);
  await optional('registry', () => {
    registry.registerBuiltin(corePlugin);
    registry.start();
    observePluginsOnline(() => registry.list());
  });
  // Brokers (lib/server/transports): a provider per kind with a driver, then the enabled connections open and discover plugins.
  await optional('broker providers', registerBrokerProviders);
  void brokerConnections.start(registry).catch((error: Error) => logger.warn('broker connections did not start', { error: error.message }));
  // The MCP gateway sidecar (lib/server/mcp/gateway-sync.ts): every main keeps its own in step; workers don't sync.
  await optional('mcp gateway sync', () => mcpGatewaySync.start());
  leaderService('seed workflows', seedWorkflows);
  // Insights backfill (first boot) and execution retention, before anything can start a run.
  leaderService('data maintenance', startDataMaintenance);
  // Audit log: publish/plugin listeners, SIEM outbox delivery and hourly retention (lib/server/audit).
  await optional('audit', startAudit);
  // Signed chain heads (lib/server/audit/anchoring.ts): the leader signs the head on a schedule and anchors it (S3, webhook).
  leaderService('audit head signing', () => auditHeads.start(), () => auditHeads.stop());
  // Binary data goes with its execution; orphaned files are swept hourly.
  await optional('binary maintenance', startBinaryMaintenance);
  // Draft and publish: an active workflow without a publication (imported after migration 200) publishes its newest version.
  leaderService('publications', ensurePublications);
  // Projects: credentials and agents (files) and anything else without a project go to the owner's personal project.
  leaderService('project adoption', adoptUnassignedResources);
  // Scheduled publishes (lib/server/publish-schedule.ts): one main publishes what is due; a restart re-reads the table.
  leaderService('scheduled publishes', () => publishSchedules.start(), () => publishSchedules.stop());
  leaderService('scheduler', () => scheduler.start(), () => scheduler.stop());
  // Webhooks of MCP trigger subscriptions whose main died (lib/server/mcp/triggers.ts).
  leaderService('mcp trigger subscriptions', () => triggerSubscriptionSweeper.start(), () => triggerSubscriptionSweeper.stop());
  // Waiting executions: re-arm their timers; overdue ones resume shortly (plugins get a moment to announce).
  leaderService('wait timers', () => waits.start(), () => waits.stop());
  // Runs a restart interrupted continue from their last checkpoint, then queued runs start (plugins announce first).
  // Queue mode: the leader hands runs whose process stopped to a worker, and starts queued runs (cluster/index.ts).
  if (clusterActive()) {
    await optional('trigger buffers', startTriggerBuffers);
    leaderService('held trigger events', () => triggerBuffers.sync(), () => triggerBuffers.stop());
  } else await optional('recovery', startRecovery);
  leaderService('retry timers', () => retries.start(), () => retries.stop());
  // Failure alerts: throttle digests and "waiting too long" checks.
  leaderService('alerts', () => alerts.start(), () => alerts.stop());
  leaderService('agent triggers', () => agentTriggers.start(), () => agentTriggers.stop());
  // Scheduled evaluation runs (a cron on a workflow's Evaluations tab): one main evaluates them.
  leaderService('evaluation schedules', () => evaluationSchedules.start(), () => evaluationSchedules.stop());
  // Online evaluations: a sample of finished agent runs is graded by an LLM judge.
  await optional('online evaluations', startOnlineEvaluations);
  // The second brain (docs/second-brain.md): every process records its usage and starts On Usage Event workflows for
  // what it recorded; the leader studies, detects and checks effects.
  await optional('usage listeners', startUsageListeners);
  await optional('usage trigger', startUsageTrigger);
  leaderService('second brain', () => brain.start(), () => brain.stop());
  await optional('registry gRPC server', startRegistryGrpcServer);

  const seeds = (process.env.LANDFLOW_PLUGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  await Promise.allSettled(seeds.map((endpoint) => registry.addEndpoint(endpoint, 'static')));
  // LANDFLOW_PLUGIN_DISCOVERY=kubernetes: plugins behind labelled Services, next to the sources above (plugins/kubernetes.ts).
  if ((process.env.LANDFLOW_PLUGIN_DISCOVERY ?? '').split(',').some((mode) => mode.trim().toLowerCase() === 'kubernetes')) {
    void import('./plugins/kubernetes').then((k8s) => k8s.startKubernetesDiscovery()).catch((error: Error) => logger.warn('kubernetes discovery did not start', { error: error.message }));
  }

  if (process.env.LANDFLOW_SCAN_ON_START !== 'false') {
    // Pick up plugins that started before the host (they keep re-announcing anyway).
    setTimeout(() => void registry.scan().catch(() => {}), 1_500).unref?.();
  }
  // Node plugins installed from a marketplace run as child processes of the host.
  await optional('node plugins', () => marketplace.startNodePlugins());
  // App webhook triggers: check the hooks of published workflows once plugins had a moment to announce; retry failures.
  setTimeout(() => leaderService('app webhooks', () => appWebhooks.start(), () => appWebhooks.stop()), 3_000).unref?.();
  // Email Trigger (IMAP) with Listen: IDLE keeps a connection per published trigger and polls on new mail.
  setTimeout(() => leaderService('IMAP IDLE', () => imapIdle.start(), () => imapIdle.stop()), 3_000).unref?.();
  registerShutdown();
  markBooted();
  logger.info('host ready: registry, scheduler and discovery running');
}
