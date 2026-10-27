/**
 * The cluster runtime (queue mode): `startCluster()` connects a main or a worker to Valkey and wires everything
 * that has to work across processes:
 *
 * - the relay (./relay): live events from every process on each main's bus (the editor's SSE stream), each worker's
 *   results to the inbox of the main that waits for them, cancel and stop-all to everyone, timers to the leader;
 * - caches dropped when another process changed their tables (workflows, folders, Data Tables, publications, the
 *   plugin list; credentials are reread when the `credentials` table, or the shared data directory's file, changes);
 * - marketplace node plugins: every main and worker runs its own copy of each installed one (../marketplace/service.ts);
 * - debugger commands for a session another main holds (./debug.ts);
 * - heartbeats: this process in the instance list, the leases of its runs, the slots of its limited runs;
 * - mains: leader election (./leader) and the leader's services: the scheduler and poll triggers, IMAP IDLE, app
 *   webhook registration, wait / retry / held-event timers, alerts, agent triggers and retention, plus a sweep every
 *   15 s that re-arms timers, starts queued runs and hands runs whose process died to a worker;
 * - workers: the job loop (./worker) and their health endpoint.
 *
 * Regular mode never calls any of it (`leaderService` just starts the service).
 */
import { createServer, type Server } from 'node:http';
import { hostname } from 'node:os';
import type { Workflow } from '@landflow/engine';
import packageJson from '../../../../package.json';
import type { EditLockView } from '../../shared/auth';
import type { ClusterStatus } from '../../shared/cluster';
import { editLocks } from '../auth/edit-locks';
import { bus, setBusRelay, type BusEvent } from '../bus';
import { priorityOf } from '../concurrency';
import { credentials } from '../credentials/vault';
import { database } from '../db';
import { emitTablesChanged, onTablesChanged, refreshRows, replicating, type TablesChanged } from '../db/replication';
import type { TableName } from '../db/schema';
import { reloadFolders } from '../folders';
import { publicationChangedElsewhere } from '../publications';
import { retries } from '../retries';
import { abortLocalExecution, abortLocalExecutions, debugExecution, drainQueues, failExecution, localExecutions } from '../runner';
import { scheduler } from '../scheduler';
import { singleton } from '../singleton';
import { store } from '../store';
import { prometheusText } from '../telemetry';
import { logger } from '../telemetry/logger';
import { triggerBuffers } from '../trigger-buffers';
import { waits } from '../waits';
import { checkClusterConfig, ClusterConfigError, leaseMs, type ClusterConfig, type ProcessRole } from './config';
import type { Coordinator, InstanceInfo, QueueJob } from './coordinator';
import { answerDebugRequest, settleDebugRequest, type DebugResultMessage } from './debug';
import { awaitedRuns, handleInbox, type InboxMessage } from './dispatch';
import { LeaderElector } from './leader';
import { exclusive } from './limits';
import { clusterSnapshot, observeCluster, recordElection, updateSnapshot } from './metrics';
import { persistOnRegistryEvents, syncRegistrations } from './plugins';
import { Relay } from './relay';
import { clusterActive, clusterState, type ControlMessage } from './state';
import { MemoryCoordinator } from './memory';
import { ValkeyCoordinator } from './valkey';
import { JobWorker } from './worker';

export { ClusterConfigError, clusterActive };
export type { ClusterStatus };

const SWEEP_MS = 15_000;
const SCHEDULER_KEY = 'scheduler:state';
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Leader services
// ---------------------------------------------------------------------------

interface LeaderServiceEntry {
  name: string;
  start: () => unknown;
  stop?: () => unknown;
  running: boolean;
}

const services = singleton('cluster-leader-services', () => [] as LeaderServiceEntry[]);

/**
 * A service only one main may run (the scheduler, timers, retention). Regular mode (or a worker): starts it now.
 * Queue mode on a main: starts it while this main leads, stops it when it no longer does.
 */
export function leaderService(name: string, start: () => unknown, stop?: () => unknown): void {
  const { config } = clusterState();
  // Regular mode: exactly as before (started here and now).
  if (config.mode !== 'queue' || config.role !== 'main') {
    start();
    return;
  }
  const entry: LeaderServiceEntry = { name, start, ...(stop && { stop }), running: false };
  services.push(entry);
  if (clusterState().elector?.isLeader()) void startService(entry);
}

async function startService(entry: LeaderServiceEntry) {
  if (entry.running) return;
  entry.running = true;
  try {
    await entry.start();
  } catch (error) {
    logger.warn(`${entry.name} failed to start`, { error: (error as Error).message });
  }
}

async function stopService(entry: LeaderServiceEntry) {
  if (!entry.running) return;
  entry.running = false;
  try {
    await entry.stop?.();
  } catch (error) {
    logger.warn(`${entry.name} failed to stop`, { error: (error as Error).message });
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export interface StartClusterOptions {
  /** Override LANDFLOW_ROLE (worker-main passes `worker`). */
  role?: ProcessRole;
  /** A coordinator to use instead of Valkey (tests: MemoryCoordinator). */
  coordinator?: Coordinator;
  /** Workers: listen for health checks (default LANDFLOW_WORKER_PORT). */
  healthPort?: number;
}

/** Start queue mode in this process. Returns false in regular mode. Throws ClusterConfigError for setups it refuses. */
export async function startCluster(options: StartClusterOptions = {}): Promise<boolean> {
  const state = clusterState();
  if (options.role && options.role !== state.config.role) state.config = { ...state.config, role: options.role, instanceId: options.role === 'worker' && !state.config.stableId ? state.config.instanceId.replace(/^main-/, 'worker-') : state.config.instanceId };
  const { config } = state;
  for (const warning of checkClusterConfig(config)) logger.warn(warning);
  if (config.mode !== 'queue') return false;
  if (state.started) return true;
  return singleton('cluster-start', () => start(config, options));
}

async function start(config: ClusterConfig, options: StartClusterOptions): Promise<boolean> {
  const state = clusterState();
  const coordinator =
    options.coordinator ??
    (process.env.LANDFLOW_VALKEY_URL === 'memory' ? new MemoryCoordinator() : new ValkeyCoordinator(config.valkeyUrl, config.prefix, config.instanceId, { sentinel: config.sentinel, cluster: config.cluster }));
  if (coordinator instanceof ValkeyCoordinator) {
    try {
      await coordinator.ping(config.sentinel || config.cluster ? 15_000 : 5_000);
    } catch (error) {
      await coordinator.close().catch(() => {});
      const where = config.cluster
        ? `through the cluster nodes ${config.cluster.nodes.map((n) => `${n.host}:${n.port}`).join(', ')}`
        : config.sentinel
        ? `through the sentinels ${config.sentinel.sentinels.map((s) => `${s.host}:${s.port}`).join(', ')} (primary "${config.sentinel.masterName}")`
        : `at ${redact(config.valkeyUrl)}`;
      throw new ClusterConfigError(`Queue mode can't reach Valkey ${where}: ${(error as Error).message}. Set LANDFLOW_VALKEY_URL${config.sentinel ? ' and LANDFLOW_VALKEY_SENTINELS' : ''}${config.cluster ? ' and LANDFLOW_VALKEY_CLUSTER' : ''}.`);
    }
  }
  const relay = new Relay(coordinator, config.instanceId);
  state.coordinator = coordinator;
  state.relay = relay;
  state.started = true;
  state.startedAt = new Date().toISOString();
  observeCluster();
  const stoppers = state.stoppers;

  // Results of the runs this process waits for.
  await relay.receive<InboxMessage | DebugResultMessage>((message) => (message.t === 'debug-result' ? settleDebugRequest(message) : handleInbox(message)));
  // Cancel, stop-all and the timers handed to the leader.
  await relay.listen<ControlMessage>('control', (message) => void onControl(message));
  state.forward = (message) => {
    void database()
      .flush()
      .catch(() => {})
      .then(() => relay.broadcast<ControlMessage>('control', message));
  };

  // Live events: this process's go out; mains show everyone's.
  setBusRelay((event) => {
    if (event.channel === 'execution' || event.channel === 'agent' || event.channel === 'lock') void relay.broadcast<BusEvent>('bus', event);
  });
  stoppers.push(() => setBusRelay(undefined));
  if (config.role === 'main') {
    await relay.listen<BusEvent & { renew?: boolean }>('bus', (event) => {
      if (event.channel === 'lock') editLocks.applyRemote(event.workflowId, event.lock);
      if (event.renew) return;
      bus.publishRelayed(event);
    });
    editLocks.onRenew = (lock: EditLockView) => void relay.broadcast('bus', { channel: 'lock', workflowId: lock.workflowId, lock, renew: true });
    stoppers.push(() => (editLocks.onRenew = undefined));
  }

  // Caches of what other processes changed.
  stoppers.push(onTablesChanged(invalidateCaches));
  if (!replicating()) {
    // SQLite on one host: the processes share the file; tell each other which tables changed.
    await relay.listen<string[]>('changes', (tables) => emitTablesChanged({ tables: new Set(tables as TableName[]), keys: new Map() }));
    stoppers.push(broadcastWrites(relay));
  }
  const vaultTimer = setInterval(() => credentials.reloadIfChanged(), 1_000);
  vaultTimer.unref?.();
  stoppers.push(() => clearInterval(vaultTimer));

  // Held trigger events: one process at a time changes a trigger's buffers.
  triggerBuffers.shared = { exclusive: (name, fn) => exclusive(coordinator, name, fn), refresh: (where) => refreshRows('trigger_buffers', where) };
  stoppers.push(() => (triggerBuffers.shared = undefined));

  // Plugins: every process connects to what the mains registered.
  if (config.role === 'main') stoppers.push(persistOnRegistryEvents(config.instanceId));
  void syncRegistrations().catch(() => {});
  const pluginTimer = setInterval(() => void syncRegistrations().catch(() => {}), 30_000);
  pluginTimer.unref?.();
  stoppers.push(() => clearInterval(pluginTimer));

  // Heartbeat: this process, its runs' leases and slots.
  const beat = setInterval(() => void heartbeat(), config.heartbeatMs);
  beat.unref?.();
  stoppers.push(() => clearInterval(beat));
  await heartbeat();

  if (config.role === 'main') startElection(config, coordinator);
  else await startWorker(config, coordinator, relay, options.healthPort ?? config.workerPort);

  // Marketplace node plugins: this process runs its own copy of each installed one.
  try {
    const { marketplace } = await import('../marketplace/service');
    stoppers.push(marketplace.startClusterSync());
  } catch (error) {
    logger.warn('cluster: marketplace node plugins not started', { error: (error as Error).message });
  }

  logger.info('queue mode running', {
    'landflow.cluster.role': config.role,
    'landflow.cluster.instance': config.instanceId,
    'landflow.cluster.coordinator': coordinator.kind,
    ...(config.role === 'worker' && { 'landflow.worker.concurrency': config.workerConcurrency }),
  });
  return true;
}

const redact = (url: string) => url.replace(/\/\/([^@/]*)@/, '//***@');

/** Stop queue mode in this process (tests, and a worker's shutdown after its jobs are handed back). */
export async function stopCluster(): Promise<void> {
  const state = clusterState();
  if (!state.started) return;
  for (const entry of [...services].reverse()) await stopService(entry);
  await state.elector?.stop().catch(() => {});
  for (const stop of state.stoppers.splice(0).reverse()) await Promise.resolve().then(stop).catch(() => {});
  await state.coordinator?.forget(state.config.instanceId).catch(() => {});
  await state.relay?.close().catch(() => {});
  await state.coordinator?.close().catch(() => {});
  services.length = 0;
  state.started = false;
  state.coordinator = undefined;
  state.relay = undefined;
  state.elector = undefined;
  state.forward = undefined;
  state.draining = false;
  singletonReset('cluster-start');
}

function singletonReset(key: string) {
  (globalThis as unknown as { __landflow?: Map<string, unknown> }).__landflow?.delete(key);
}

// ---------------------------------------------------------------------------
// Control messages
// ---------------------------------------------------------------------------

async function onControl(message: ControlMessage) {
  switch (message.t) {
    case 'cancel':
      abortLocalExecution(message.id);
      return;
    case 'stop-all':
      abortLocalExecutions();
      return;
    case 'wait':
      if (clusterState().elector?.isLeader()) await waits.sync(message.id);
      return;
    case 'retry':
      if (clusterState().elector?.isLeader()) await retries.sync(message.id);
      return;
    case 'buffer':
      if (clusterState().elector?.isLeader()) await triggerBuffers.sync(message.key);
      return;
    case 'marketplace':
      await import('../marketplace/service').then(({ marketplace }) => marketplace.syncNodePlugins());
      return;
    case 'listener-replaced':
      // Loaded lazily: test URLs reach the runner.
      await import('../test-webhooks').then(({ onListenerReplaced }) => onListenerReplaced(message.id));
      return;
    case 'debug':
      answerDebugRequest(message, debugExecution);
  }
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

const dataTableCache = () => singleton('data-tables-sql-cache', () => new Map<string, unknown>());

/** Another process changed these tables: drop what this process keeps of them. */
export function invalidateCaches(change: TablesChanged) {
  const { tables, keys } = change;
  if (tables.has('workflows')) store.reloadWorkflows();
  if (tables.has('folders')) reloadFolders();
  if (tables.has('data_tables') || tables.has('data_table_rows')) {
    const cache = dataTableCache();
    const ids = [...(keys.get('data_tables') ?? []), ...(keys.get('data_table_rows') ?? [])].map((key) => String(key[0]));
    if (ids.length) ids.forEach((id) => cache.delete(id));
    else cache.clear();
  }
  if (tables.has('workflow_publications')) {
    for (const key of keys.get('workflow_publications') ?? []) publicationChangedElsewhere(String(key[0]));
  }
  if (tables.has('plugin_registrations')) void syncRegistrations().catch(() => {});
}

/** SQLite on one host: after each write, tell the other processes which tables changed (batched per tick). */
function broadcastWrites(relay: Relay): () => void {
  let pending: Set<string> | undefined;
  return database().observe((ops) => {
    if (!pending) {
      pending = new Set();
      setImmediate(() => {
        const tables = [...(pending ?? [])];
        pending = undefined;
        void relay.broadcast('changes', tables);
      });
    }
    for (const op of ops) pending.add(op.table);
  });
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

let beating = false;

async function heartbeat() {
  const state = clusterState();
  const valkey = state.coordinator;
  if (!valkey || beating) return;
  beating = true;
  const { config } = state;
  try {
    const runs = localExecutions();
    const info: InstanceInfo = {
      id: config.instanceId,
      role: config.role,
      hostname: hostname(),
      pid: process.pid,
      startedAt: state.startedAt,
      lastSeen: new Date().toISOString(),
      active: runs.length,
      version: packageJson.version,
      ...(config.role === 'worker' && { concurrency: config.workerConcurrency, processed: state.processed, port: config.workerPort }),
      ...(config.role === 'main' && { leader: Boolean(state.elector?.isLeader()), awaiting: awaitedRuns() }),
      ...(state.draining && { draining: true }),
    };
    await valkey.heartbeat(info, config.heartbeatMs * 3);
    const ttl = leaseMs(config);
    // The leases of this process's runs: a run whose lease another process took (it thought this one dead) stops here.
    await Promise.all(
      runs.map(async (run) => {
        const key = `lease:${run.executionId}`;
        if (await valkey.extendIfValue(key, config.instanceId, ttl)) return;
        if (await valkey.setIfAbsent(key, config.instanceId, ttl)) return;
        logger.warn('cluster: another process took over this run; stopping it here', { 'landflow.execution.id': run.executionId });
        abortLocalExecution(run.executionId);
      }),
    );
    const limited = runs.filter((run) => run.limited);
    if (limited.length) await valkey.holdSlots(limited.map(({ workflowId, executionId }) => ({ workflowId, executionId })), ttl);
    // A cancel broadcast this process missed (a reconnect).
    if (runs.length) {
      const canceled = await valkey.getMany(runs.map((run) => `canceled:${run.executionId}`));
      runs.forEach((run, index) => canceled[index] && abortLocalExecution(run.executionId));
    }
    const [stats, instances] = await Promise.all([valkey.queueStats(), valkey.instances()]);
    updateSnapshot({
      depth: stats.waiting,
      active: stats.active,
      workers: instances.filter((instance) => instance.role === 'worker').length,
      mains: instances.filter((instance) => instance.role === 'main').length,
      leader: Boolean(state.elector?.isLeader()),
    });
  } catch (error) {
    logger.debug('cluster: heartbeat failed', { error: (error as Error).message });
  } finally {
    beating = false;
  }
}

// ---------------------------------------------------------------------------
// Mains: leadership
// ---------------------------------------------------------------------------

function startElection(config: ClusterConfig, coordinator: Coordinator) {
  const state = clusterState();
  let sweepTimer: NodeJS.Timeout | undefined;
  let snapshotTimer: NodeJS.Timeout | undefined;
  const elector = new LeaderElector(coordinator, config.instanceId, config.leaderTtlMs, {
    onElected: async (token) => {
      recordElection();
      logger.info('cluster: this main leads now', { 'landflow.cluster.instance': config.instanceId, 'landflow.cluster.fencing_token': token });
      // The schedules go on where the last leader left them.
      try {
        const saved = await coordinator.get(SCHEDULER_KEY);
        scheduler.restore(saved ? JSON.parse(saved) : undefined);
      } catch (error) {
        logger.warn('cluster: could not read the scheduler state', { error: (error as Error).message });
      }
      for (const entry of services) await startService(entry);
      snapshotTimer = setInterval(() => void saveScheduler(coordinator), 2_000);
      snapshotTimer.unref?.();
      sweepTimer = setInterval(() => void leaderSweep(coordinator), SWEEP_MS);
      sweepTimer.unref?.();
      void leaderSweep(coordinator);
      // Settings → Workers shows the new leader now, not at the next heartbeat.
      void heartbeat();
    },
    onDemoted: async (reason) => {
      logger.warn('cluster: this main no longer leads', { 'landflow.cluster.instance': config.instanceId, reason });
      clearInterval(snapshotTimer);
      clearInterval(sweepTimer);
      // Stopping on purpose (it hasn't resigned yet, so nobody else leads): the next leader starts from here.
      if (reason === 'stopping') await saveScheduler(coordinator, true);
      for (const entry of [...services].reverse()) await stopService(entry);
      if (reason !== 'stopping') void heartbeat();
    },
  });
  state.elector = elector;
  elector.start();
}

async function saveScheduler(coordinator: Coordinator, stepping = false) {
  if (!stepping && !clusterState().elector?.isLeader()) return;
  await coordinator.set(SCHEDULER_KEY, JSON.stringify(scheduler.snapshot()), DAY_MS).catch(() => {});
}

/** Runs seen without a lease or a job in the last sweep (acted on when seen twice). */
const suspects = singleton('cluster-orphan-suspects', () => new Set<string>());
let sweeping = false;

/** The leader, every 15 s: timers it may have missed, queued runs that can start, runs whose process died. */
export async function leaderSweep(coordinator: Coordinator): Promise<void> {
  if (sweeping || !clusterState().elector?.isLeader()) return;
  sweeping = true;
  try {
    await waits.sync();
    await retries.sync();
    await triggerBuffers.sync();
    drainQueues();
    await adoptOrphans(coordinator);
  } catch (error) {
    logger.warn('cluster: leader sweep failed', { error: (error as Error).message });
  } finally {
    sweeping = false;
  }
}

/**
 * Runs saved as running or queued that nobody holds: no lease (no process runs it), no job in the queue (no worker will
 * take it) and not in a FIFO. A running one goes to a worker, which continues it from its last checkpoint; a queued
 * one goes back into its workflow's FIFO.
 */
export async function adoptOrphans(coordinator: Coordinator): Promise<number> {
  const local = new Set(localExecutions().map((run) => run.executionId));
  const candidates = [...store.executionsWithStatus('running'), ...store.executionsWithStatus('queued')].filter((record) => !local.has(record.executionId));
  if (!candidates.length) {
    suspects.clear();
    return 0;
  }
  const values = await coordinator.getMany(candidates.flatMap((record) => [`lease:${record.executionId}`, `job:${record.executionId}`]));
  const seen = new Set<string>();
  let adopted = 0;
  for (const [index, record] of candidates.entries()) {
    const id = record.executionId;
    if (values[index * 2] || values[index * 2 + 1]) continue;
    if (record.status === 'queued' && (await coordinator.isQueued(record.workflowId, id))) continue;
    seen.add(id);
    if (!suspects.has(id)) continue;
    // Seen twice: read it fresh, it may have just finished.
    await refreshRows('executions', { id });
    const fresh = store.getExecution(id);
    if (!fresh || (fresh.status !== 'running' && fresh.status !== 'queued')) continue;
    adopted++;
    if (fresh.status === 'queued') {
      logger.info('cluster: a queued execution nobody held goes back into its queue', { 'landflow.execution.id': id });
      await coordinator.addToQueue(fresh.workflowId, id, Date.parse(fresh.queued?.queuedAt ?? fresh.startedAt) || 0);
      continue;
    }
    const workflow = fresh.workflow ?? store.getWorkflow(fresh.workflowId);
    if (!workflow) {
      failExecution(fresh, 'The process running this execution stopped, and its workflow no longer exists');
      continue;
    }
    logger.info('cluster: a run whose process stopped goes to a worker', { 'landflow.execution.id': id });
    const job: QueueJob = { executionId: id, workflowId: fresh.workflowId, expect: 'running', ...(priorityOf((workflow as Workflow).settings) !== 'normal' && { priority: priorityOf((workflow as Workflow).settings) }), record: fresh, workflow: workflow as Workflow, engine: {}, enqueuedAt: new Date().toISOString() };
    await coordinator.set(`job:${id}`, clusterState().config.instanceId, DAY_MS);
    await coordinator.enqueue(job);
  }
  suspects.clear();
  for (const id of seen) suspects.add(id);
  if (adopted) drainQueues();
  return adopted;
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

async function startWorker(config: ClusterConfig, coordinator: Coordinator, relay: Relay, port: number) {
  const state = clusterState();
  const worker = new JobWorker(coordinator, relay, config);
  worker.start();
  state.worker = worker;
  state.stoppers.push(async () => void (await worker.stop(0)));
  if (port > 0) {
    const server = await listenHealth(port);
    state.stoppers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  }
}

function listenHealth(port: number): Promise<Server> {
  const server = createServer((request, response) => {
    void (async () => {
      const state = clusterState();
      if (request.url?.startsWith('/metrics')) {
        const text = await prometheusText().catch(() => undefined);
        response.writeHead(text ? 200 : 404, { 'content-type': 'text/plain; version=0.0.4' });
        response.end(text ?? 'Prometheus metrics are off (LANDFLOW_METRICS_PROMETHEUS=false)\n');
        return;
      }
      if (request.url === '/healthz' || request.url === '/' || request.url?.startsWith('/health')) {
        const status = clusterStatus();
        response.writeHead(state.draining ? 503 : 200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: state.draining ? 'draining' : 'ok', ...status.self }));
        return;
      }
      response.writeHead(404).end();
    })();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

// ---------------------------------------------------------------------------
// Status (Settings → Workers, health)
// ---------------------------------------------------------------------------

/** What this process knows without asking Valkey. */
export function clusterStatus(): ClusterStatus {
  const state = clusterState();
  const { config } = state;
  return {
    mode: clusterActive() ? 'queue' : 'regular',
    database: database().kind,
    self: {
      id: config.instanceId,
      role: config.role,
      active: localExecutions().length,
      startedAt: state.startedAt,
      ...(config.role === 'worker' && { processed: state.processed, concurrency: config.workerConcurrency }),
      ...(config.role === 'main' && clusterActive() && { leader: Boolean(state.elector?.isLeader()) }),
    },
  };
}

/** The full picture (instances, queue, leader), read from Valkey. */
export async function clusterOverview(): Promise<ClusterStatus> {
  const status = clusterStatus();
  const state = clusterState();
  const valkey = state.coordinator;
  if (!clusterActive() || !valkey) return status;
  const { config } = state;
  const [leadership, queue, instances] = await Promise.all([valkey.leadership(), valkey.queueStats(), valkey.instances()]);
  return {
    ...status,
    coordinator: valkey.kind,
    leader: { ...(leadership.holder && { holder: leadership.holder }), token: leadership.token },
    queue,
    instances: instances.sort((a, b) => a.role.localeCompare(b.role) || a.id.localeCompare(b.id)),
    settings: {
      concurrency: config.workerConcurrency,
      offloadManual: config.offloadManual,
      leaderTtlSeconds: config.leaderTtlMs / 1000,
      stalledSeconds: config.stalledMs / 1000,
      prefix: config.prefix,
    },
  };
}

export { clusterSnapshot };
