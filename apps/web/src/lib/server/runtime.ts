/**
 * The composition root: every service a process starts, in one table, for both roles. `main` (the Next.js host,
 * instrumentation.ts) and `worker` (`pnpm worker`, cluster/worker-main.ts) read the same SERVICES list and each runs the
 * entries whose `roles` include it, in list order, so a service added here can't be forgotten in one of them.
 *
 * Boot order matters and is the order bootstrap.ts and worker-main.ts used to have: the configuration check, the
 * database, then (main) the cluster runtime before anything that elects a leader; a worker starts its cluster runtime
 * last, once it can reach plugins, because that is when it begins taking jobs.
 *
 * Failure policy (lib/server/lifecycle.ts): the configuration check, the database and the cluster runtime are required;
 * a failure there marks the boot failed, forgets the cached promise (a later call retries) and, under Next.js, exits
 * so the orchestrator restarts the pod instead of keeping a process that answers 500 to everything. Every other step
 * is optional: logged, counted (`landflow.process.errors{kind="service_start"}`), and the process keeps going.
 * `leader` entries go through `leaderService()` (cluster/index.ts): started where the leader is, moved with leadership.
 * Shutdown steps are registered at the end of a successful boot, in their phases.
 */
import { agentTriggers } from './agents/triggers';
import { alerts } from './alerts/service';
import { auditHeads } from './audit/anchoring';
import { startAudit } from './audit/start';
import { appWebhooks } from './app-webhooks';
import { bootstrapOwnerFromEnv } from './auth/bootstrap';
import { startBinaryMaintenance } from './binary/access';
import { brain } from './brain';
import { startUsageTrigger } from './brain/usage-trigger';
import { clusterActive, leaderService, startCluster, stopCluster, stopLeaderServices } from './cluster';
import { clusterState } from './cluster/state';
import { checkConfig, ConfigError, profile } from './config';
import { closeDatabase, openDatabase } from './db';
import { startOnlineEvaluations } from './evaluations/online';
import { evaluationSchedules } from './evaluations/schedule';
import { imapIdle } from './imap-idle';
import { countProcessError, isDraining, markBootFailed, markBooted, onShutdown, shutdownDeadlineMs, type ShutdownPhase } from './lifecycle';
import { marketplace } from './marketplace/service';
import { mcpGatewaySync } from './mcp/gateway-sync';
import { triggerSubscriptionSweeper } from './mcp/triggers';
import { startDataMaintenance } from './maintenance';
import { corePlugin } from './nodes';
import { registry } from './plugins/registry';
import { startRegistryGrpcServer } from './plugins/registry-grpc';
import { adoptUnassignedResources } from './projects/boot';
import { ensurePublications } from './publish';
import { publishSchedules } from './publish-schedule';
import { retries } from './retries';
import { localExecutions, startRecovery, startTriggerBuffers } from './runner';
import { scheduler } from './scheduler';
import { seedWorkflows } from './seed';
import { forgetSingleton, singleton } from './singleton';
import { logger, observePluginsOnline } from './telemetry';
import { registerBrokerProviders } from './transports/broker-provider';
import { brokerConnections } from './transports/brokers';
import { triggerBuffers } from './trigger-buffers';
import { startUsageListeners } from './usage/listeners';
import { waits } from './waits';

export type Role = 'main' | 'worker';

export interface ServiceSpec {
  name: string;
  roles: Role[];
  /** Run through `leaderService()`: on the elected leader in queue mode, right here otherwise. */
  leader?: boolean;
  /** A failure refuses the boot (see the header); the default is optional. */
  required?: boolean;
  /** Start after this many ms (still skipped once the process is draining). */
  delayMs?: number;
  /** Skip the entry when this says no, evaluated when the entry's turn comes (after the cluster runtime started). */
  when?: () => boolean;
  start(): unknown;
  /** Leader entries: passed to `leaderService()`. Others: registered with `onShutdown` in `shutdownPhase`. */
  stop?(): unknown;
  shutdownPhase?: ShutdownPhase;
}

const MAIN: Role[] = ['main'];
const BOTH: Role[] = ['main', 'worker'];
const WORKER: Role[] = ['worker'];

const staticSeeds = () => (process.env.LANDFLOW_PLUGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const kubernetesDiscovery = () => (process.env.LANDFLOW_PLUGIN_DISCOVERY ?? '').split(',').some((mode) => mode.trim().toLowerCase() === 'kubernetes');

/** Fail the boot on production-profile errors; always log the effective configuration (secrets as `[set]`). */
function configCheck(): void {
  const check = checkConfig();
  for (const warning of check.warnings) logger.warn(warning);
  logger.info('effective configuration', { profile: profile(), effective: check.effective });
  // `next build` runs with NODE_ENV=production but without the deployment's environment: it only warns there.
  const building = process.env.NEXT_PHASE === 'phase-production-build';
  if (profile() === 'production' && !building && check.errors.length > 0) throw new ConfigError(check.errors);
  for (const problem of check.errors) logger.warn(problem);
}

export const SERVICES: ServiceSpec[] = [
  { name: 'config check', roles: BOTH, required: true, start: configCheck },
  // SQLite opens lazily on first use; Postgres mode loads its mirror here, before anything reads the store.
  { name: 'database', roles: BOTH, required: true, start: openDatabase },
  // Queue mode: Valkey, the relay and the leader election (refuses SQLite without LANDFLOW_QUEUE_ALLOW_SQLITE).
  // `{ role: 'main' }` is explicit: a process that booted as a main is a main here, whatever LANDFLOW_ROLE says.
  { name: 'cluster', roles: MAIN, required: true, start: () => startCluster({ role: 'main' }) },
  // LANDFLOW_OWNER_EMAIL / LANDFLOW_OWNER_PASSWORD: the owner, created at boot while there is no user (Docker, CI).
  { name: 'owner from environment', roles: MAIN, start: bootstrapOwnerFromEnv },
  {
    name: 'registry',
    roles: BOTH,
    start: () => {
      registry.registerBuiltin(corePlugin);
      registry.start();
      observePluginsOnline(() => registry.list());
    },
  },
  // Brokers (lib/server/transports): a provider per kind with a driver, then the enabled connections open and discover
  // plugins. Workers open them too and choose transports for themselves (own hostInstanceId and reply channel).
  { name: 'broker providers', roles: BOTH, start: registerBrokerProviders },
  {
    name: 'broker connections',
    roles: BOTH,
    // Not awaited: connecting may take a while and must not hold the boot.
    start: () => void brokerConnections.start(registry).catch((error: Error) => logger.warn('broker connections did not start', { error: error.message })),
    stop: () => brokerConnections.stop(),
    // After the runs: a run in flight may still be talking over a broker.
    shutdownPhase: 'cluster',
  },
  // The MCP gateway sidecar (lib/server/mcp/gateway-sync.ts): every main keeps its own in step; workers don't sync.
  { name: 'mcp gateway sync', roles: MAIN, start: () => mcpGatewaySync.start(), stop: () => mcpGatewaySync.stop(), shutdownPhase: 'services' },
  { name: 'seed workflows', roles: MAIN, leader: true, start: seedWorkflows },
  // Insights backfill (first boot) and execution retention, before anything can start a run.
  { name: 'data maintenance', roles: MAIN, leader: true, start: startDataMaintenance },
  // Audit log: publish/plugin listeners, SIEM outbox delivery and hourly retention (lib/server/audit).
  { name: 'audit', roles: MAIN, start: startAudit },
  // Signed chain heads (lib/server/audit/anchoring.ts): the leader signs the head on a schedule and anchors it (S3, webhook).
  { name: 'audit head signing', roles: MAIN, leader: true, start: () => auditHeads.start(), stop: () => auditHeads.stop() },
  // Binary data goes with its execution (a run that isn't kept is deleted where it ran); orphaned files are swept hourly.
  { name: 'binary maintenance', roles: BOTH, start: startBinaryMaintenance },
  // Draft and publish: an active workflow without a publication (imported after migration 200) publishes its newest version.
  { name: 'publications', roles: MAIN, leader: true, start: ensurePublications },
  // Projects: credentials and agents (files) and anything else without a project go to the owner's personal project.
  { name: 'project adoption', roles: MAIN, leader: true, start: adoptUnassignedResources },
  // Scheduled publishes (lib/server/publish-schedule.ts): one main publishes what is due; a restart re-reads the table.
  { name: 'scheduled publishes', roles: MAIN, leader: true, start: () => publishSchedules.start(), stop: () => publishSchedules.stop() },
  { name: 'scheduler', roles: MAIN, leader: true, start: () => scheduler.start(), stop: () => scheduler.stop() },
  // Webhooks of MCP trigger subscriptions whose main died (lib/server/mcp/triggers.ts).
  { name: 'mcp trigger subscriptions', roles: MAIN, leader: true, start: () => triggerSubscriptionSweeper.start(), stop: () => triggerSubscriptionSweeper.stop() },
  // Waiting executions: re-arm their timers; overdue ones resume shortly (plugins get a moment to announce).
  { name: 'wait timers', roles: MAIN, leader: true, start: () => waits.start(), stop: () => waits.stop() },
  // Runs a restart interrupted continue from their last checkpoint, then queued runs start (plugins announce first).
  // Queue mode: the leader hands runs whose process stopped to a worker, and starts queued runs (cluster/index.ts).
  { name: 'trigger buffers', roles: MAIN, when: clusterActive, start: startTriggerBuffers },
  { name: 'held trigger events', roles: MAIN, leader: true, when: clusterActive, start: () => triggerBuffers.sync(), stop: () => triggerBuffers.stop() },
  { name: 'recovery', roles: MAIN, when: () => !clusterActive(), start: startRecovery },
  { name: 'retry timers', roles: MAIN, leader: true, start: () => retries.start(), stop: () => retries.stop() },
  // Failure alerts: throttle digests and "waiting too long" checks.
  { name: 'alerts', roles: MAIN, leader: true, start: () => alerts.start(), stop: () => alerts.stop() },
  { name: 'agent triggers', roles: MAIN, leader: true, start: () => agentTriggers.start(), stop: () => agentTriggers.stop() },
  // Scheduled evaluation runs (a cron on a workflow's Evaluations tab): one main evaluates them.
  { name: 'evaluation schedules', roles: MAIN, leader: true, start: () => evaluationSchedules.start(), stop: () => evaluationSchedules.stop() },
  // Online evaluations: a sample of finished agent runs is graded by an LLM judge (on every process that runs agents).
  { name: 'online evaluations', roles: BOTH, start: startOnlineEvaluations },
  // The second brain (docs/second-brain.md): every process records its usage and starts On Usage Event workflows for
  // what it recorded; the leader studies, detects and checks effects.
  { name: 'usage listeners', roles: MAIN, start: startUsageListeners },
  { name: 'usage trigger', roles: MAIN, start: startUsageTrigger },
  { name: 'second brain', roles: MAIN, leader: true, start: () => brain.start(), stop: () => brain.stop() },
  { name: 'registry gRPC server', roles: MAIN, start: startRegistryGrpcServer },
  // Static plugin seeds (LANDFLOW_PLUGINS) next to the other sources.
  { name: 'static plugin seeds', roles: BOTH, start: () => Promise.allSettled(staticSeeds().map((endpoint) => registry.addEndpoint(endpoint, 'static'))) },
  // LANDFLOW_PLUGIN_DISCOVERY=kubernetes: plugins behind labelled Services (plugins/kubernetes.ts). Not awaited.
  {
    name: 'kubernetes discovery',
    roles: BOTH,
    when: kubernetesDiscovery,
    start: () => void import('./plugins/kubernetes').then((k8s) => k8s.startKubernetesDiscovery()).catch((error: Error) => logger.warn('kubernetes discovery did not start', { error: error.message })),
  },
  // Pick up plugins that started before the host (they keep re-announcing anyway).
  { name: 'startup scan', roles: MAIN, delayMs: 1_500, when: () => process.env.LANDFLOW_SCAN_ON_START !== 'false', start: () => void registry.scan().catch(() => {}) },
  // Node plugins installed from a marketplace run as child processes of the host.
  { name: 'node plugins', roles: MAIN, start: () => marketplace.startNodePlugins() },
  // App webhook triggers: check the hooks of published workflows once plugins had a moment to announce; retry failures.
  { name: 'app webhooks', roles: MAIN, leader: true, delayMs: 3_000, start: () => appWebhooks.start(), stop: () => appWebhooks.stop() },
  // Email Trigger (IMAP) with Listen: IDLE keeps a connection per published trigger and polls on new mail.
  { name: 'IMAP IDLE', roles: MAIN, leader: true, delayMs: 3_000, start: () => imapIdle.start(), stop: () => imapIdle.stop() },
  // A worker takes jobs only now: plugins and brokers are up, so what it picks up can run.
  { name: 'worker cluster', roles: WORKER, required: true, start: () => startCluster({ role: 'worker' }) },
];

/** The entries a role runs, in boot order. */
export const servicesFor = (role: Role): ServiceSpec[] => SERVICES.filter((spec) => spec.roles.includes(role));

/** Run an optional boot step: a throw or a rejection is logged and counted, and the boot goes on. */
async function optional(name: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (error) {
    logger.warn('service failed to start', { service: name, error: (error as Error).message });
    countProcessError('service_start');
  }
}

/** Start `spec` after its delay on a timer that never keeps the process alive. */
function startLater(spec: ServiceSpec): void {
  setTimeout(() => {
    if (!isDraining()) startOne(spec);
  }, spec.delayMs).unref?.();
}

function startOne(spec: ServiceSpec): void {
  if (spec.leader) leaderService(spec.name, spec.start, spec.stop);
  else void optional(spec.name, spec.start);
}

/**
 * Remaining waits for local runs at shutdown: runs still in flight are recovered from their checkpoints at the next
 * boot. The poll ends at the shutdown deadline and never keeps the process alive, so an abandoned step stops polling.
 */
async function waitForLocalRuns(): Promise<void> {
  const until = Date.now() + shutdownDeadlineMs();
  while (localExecutions().length > 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 200).unref?.());
}

function registerShutdown(role: Role, specs: ServiceSpec[]): void {
  if (role === 'main') onShutdown('leader services', stopLeaderServices, 'services');
  for (const spec of specs) if (!spec.leader && spec.stop) onShutdown(spec.name, spec.stop.bind(spec), spec.shutdownPhase ?? 'services');
  if (role === 'main') onShutdown('local runs', waitForLocalRuns, 'runs');
  else {
    // The same lifecycle registry the main uses: stop taking jobs, let runs finish, put the rest back.
    const { config } = clusterState();
    onShutdown('worker jobs', () => clusterState().worker?.stop(config.shutdownMs), 'runs', { timeoutMs: config.shutdownMs + 5_000 });
  }
  onShutdown('cluster', stopCluster, 'cluster');
  onShutdown('database', closeDatabase, 'storage');
  onShutdown('telemetry', async () => {
    const { startTelemetry } = await import('./telemetry/sdk');
    await startTelemetry().shutdown?.();
  }, 'telemetry');
}

async function bootSteps(role: Role): Promise<void> {
  const specs = servicesFor(role);
  for (const spec of specs) {
    if (spec.when && !spec.when()) continue;
    if (spec.delayMs !== undefined) startLater(spec);
    else if (spec.required) await spec.start();
    else if (spec.leader) startOne(spec);
    else await optional(spec.name, spec.start);
    // Shutdown steps go in as soon as the database is open, not at the end: a SIGTERM while a later step waits (plugin
    // seeds that don't answer) still flushes Postgres and releases the lease. Every step is safe before its service started.
    if (spec.name === 'database') registerShutdown(role, specs);
  }
  markBooted();
  logger.info(role === 'main' ? 'host ready: registry, scheduler and discovery running' : 'runtime ready', { role });
}

/**
 * A required step failed: record it and let a later call retry. Under `next start` and the image (NODE_ENV=production)
 * the process also exits so the orchestrator restarts it. Elsewhere instrumentation.ts catches the rejection, so `next dev`
 * keeps running and a later request (`handler()` → `whenReady()`) boots it again.
 */
function failBoot(error: unknown): never {
  markBootFailed(error);
  logger.error('boot failed', { error });
  const serving = process.env.NEXT_PHASE !== 'phase-production-build' && !process.env.VITEST;
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.NODE_ENV === 'production' && serving) setImmediate(() => process.exit(1));
  throw error;
}

const cleanups = new WeakSet<Promise<void>>();

/** Start the services of `role`, once per process (a failed boot is forgotten so a later call retries). */
export function startRuntime({ role }: { role: Role }): Promise<void> {
  // The main keeps the key bootstrap.ts always used ('bootstrap'), so tests and tooling that reset the boot by that
  // name keep working; the worker has its own.
  const key = role === 'main' ? 'bootstrap' : 'runtime:worker';
  const booting = singleton(key, () => bootSteps(role).catch(failBoot));
  // Forget the cached promise only once it is stored (a synchronous failure rejects before `singleton` stores it).
  if (!cleanups.has(booting)) {
    cleanups.add(booting);
    booting.catch(() => {
      if (singleton(key, () => booting) === booting) forgetSingleton(key);
    });
  }
  return booting;
}
