/**
 * Queue mode and high availability settings, from the environment (README "Queue mode, workers and high availability").
 *
 * - `LANDFLOW_EXECUTIONS_MODE`: `regular` (default: every run in the process that started it, one host per database)
 *   or `queue` (mains enqueue production runs on Valkey, workers run them; several mains elect a leader).
 * - `LANDFLOW_ROLE`: `main` (default: UI, API, webhooks) or `worker` (set by `pnpm worker`).
 * - `LANDFLOW_VALKEY_URL`: `redis://[user:password@]host:port[/db]` (`rediss://` for TLS), default `redis://127.0.0.1:6379`.
 * - `LANDFLOW_VALKEY_SENTINELS` (`host:port,host:port…`): find the primary through Valkey Sentinel instead, and follow its
 *   failovers; LANDFLOW_VALKEY_URL then gives only the primary's credentials, database and TLS. With
 *   `LANDFLOW_VALKEY_MASTER_NAME` (default `mymaster`), `LANDFLOW_VALKEY_SENTINEL_PASSWORD` (and `_USERNAME`) when
 *   the sentinels require AUTH, and `LANDFLOW_VALKEY_SENTINEL_TLS=true` when they speak TLS.
 * - `LANDFLOW_VALKEY_CLUSTER` (`host:port,host:port…`): run on a Valkey (or Redis) Cluster: every key sits under one hash tag
 *   (`{<prefix>}`), so the Lua scripts stay valid, and the client asks the cluster which node owns that slot and follows
 *   MOVED / ASK. It doesn't scale the queue out (one slot, one node); it lets cluster-mode deployments work. With
 *   `LANDFLOW_VALKEY_CLUSTER_NAT` (`announced:port=reachable:port,…`) for clusters that announce unreachable addresses.
 *   LANDFLOW_VALKEY_URL gives credentials and TLS. Not combined with Sentinel.
 * - `LANDFLOW_QUEUE_PREFIX`: the key prefix, so several installs can share one Valkey (default `landflow`).
 * - `LANDFLOW_WORKER_CONCURRENCY`: runs a worker takes at once (default 10, n8n's default).
 * - `LANDFLOW_OFFLOAD_MANUAL_EXECUTIONS=true`: editor runs go to the workers too (n8n's OFFLOAD_MANUAL_EXECUTIONS_TO_WORKERS).
 * - `LANDFLOW_QUEUE_ALLOW_SQLITE=true`: allow queue mode on SQLite, for mains and workers on one host sharing one file.
 * - `LANDFLOW_INSTANCE_ID`: this process's name in Valkey and its Postgres spool file (default `<role>-<hostname>-<pid>`);
 *   set a stable one per process in Postgres mode, so a restarted process replays its own spool.
 * - `LANDFLOW_LEADER_TTL_SECONDS` (default 10: failover in about 12 s), `LANDFLOW_STALLED_SECONDS` (default 30: a dead
 *   worker's runs are taken over after it), `LANDFLOW_WORKER_PORT` (health and metrics, default 5690, `0` = off) and
 *   `LANDFLOW_WORKER_SHUTDOWN_SECONDS` (default 30: how long SIGTERM waits for runs before re-queuing them).
 */
import { hostname } from 'node:os';
import { parseClusterNat, parseSentinels, type RespAddress, type SentinelOptions } from './resp';

export type ExecutionsMode = 'regular' | 'queue';
export type ProcessRole = 'main' | 'worker';

export interface ClusterConfig {
  mode: ExecutionsMode;
  role: ProcessRole;
  instanceId: string;
  /** Whether LANDFLOW_INSTANCE_ID was set (a stable name across restarts). */
  stableId: boolean;
  valkeyUrl: string;
  /** Valkey Sentinel (LANDFLOW_VALKEY_SENTINELS): the primary is asked of these. */
  sentinel?: SentinelOptions;
  /** Valkey Cluster (LANDFLOW_VALKEY_CLUSTER): seed nodes, and the address translation. */
  cluster?: { nodes: RespAddress[]; natMap: Record<string, RespAddress> };
  prefix: string;
  workerConcurrency: number;
  offloadManual: boolean;
  allowSqlite: boolean;
  leaderTtlMs: number;
  stalledMs: number;
  /** Run leases and job heartbeats are renewed this often. */
  heartbeatMs: number;
  workerPort: number;
  shutdownMs: number;
}

const flag = (value: string | undefined) => /^(true|1|yes|on)$/i.test(value?.trim() ?? '');
const number = (value: string | undefined, fallback: number, min: number) => {
  const n = Number(value);
  return Number.isFinite(n) && value?.trim() ? Math.max(min, n) : fallback;
};

/** The settings in `env` (default: this process's environment). */
export function clusterConfig(env: NodeJS.ProcessEnv = process.env): ClusterConfig {
  const mode: ExecutionsMode = env.LANDFLOW_EXECUTIONS_MODE?.trim().toLowerCase() === 'queue' ? 'queue' : 'regular';
  const role: ProcessRole = env.LANDFLOW_ROLE?.trim().toLowerCase() === 'worker' ? 'worker' : 'main';
  const explicitId = env.LANDFLOW_INSTANCE_ID?.trim();
  const leaderTtlMs = number(env.LANDFLOW_LEADER_TTL_SECONDS, 10, 3) * 1000;
  // A dead worker's runs wait longer than its run leases (heartbeat × 6), so a takeover never meets a live lease.
  const stalledMs = Math.max(number(env.LANDFLOW_STALLED_SECONDS, 30, 5) * 1000, 20_000);
  return {
    mode,
    role,
    instanceId: (explicitId || `${role}-${hostname()}-${process.pid}`).replace(/[^\w.-]/g, '_').slice(0, 100),
    stableId: Boolean(explicitId),
    valkeyUrl: env.LANDFLOW_VALKEY_URL?.trim() || 'redis://127.0.0.1:6379',
    ...sentinelConfig(env),
    ...clusterSettings(env),
    prefix: (env.LANDFLOW_QUEUE_PREFIX?.trim() || 'landflow').replace(/[^\w.-]/g, '_'),
    workerConcurrency: Math.floor(number(env.LANDFLOW_WORKER_CONCURRENCY, 10, 1)),
    offloadManual: flag(env.LANDFLOW_OFFLOAD_MANUAL_EXECUTIONS),
    allowSqlite: flag(env.LANDFLOW_QUEUE_ALLOW_SQLITE),
    leaderTtlMs,
    stalledMs,
    heartbeatMs: Math.min(5_000, Math.floor(stalledMs / 6)),
    workerPort: Math.floor(number(env.LANDFLOW_WORKER_PORT, 5690, 0)),
    shutdownMs: number(env.LANDFLOW_WORKER_SHUTDOWN_SECONDS, 30, 0) * 1000,
  };
}

function clusterSettings(env: NodeJS.ProcessEnv): Pick<ClusterConfig, 'cluster'> {
  const nodes = parseSentinels(env.LANDFLOW_VALKEY_CLUSTER, 6379);
  if (!nodes.length) return {};
  return { cluster: { nodes, natMap: parseClusterNat(env.LANDFLOW_VALKEY_CLUSTER_NAT) } };
}

function sentinelConfig(env: NodeJS.ProcessEnv): { sentinel?: SentinelOptions } {
  const sentinels = parseSentinels(env.LANDFLOW_VALKEY_SENTINELS);
  if (!sentinels.length) return {};
  const username = env.LANDFLOW_VALKEY_SENTINEL_USERNAME?.trim();
  const password = env.LANDFLOW_VALKEY_SENTINEL_PASSWORD?.trim();
  return {
    sentinel: {
      sentinels,
      masterName: env.LANDFLOW_VALKEY_MASTER_NAME?.trim() || 'mymaster',
      ...(username && { username }),
      ...(password && { password }),
      ...(flag(env.LANDFLOW_VALKEY_SENTINEL_TLS) && { tls: true }),
    },
  };
}

/** Run leases last this long without a renewal (a few heartbeats). */
export const leaseMs = (config: ClusterConfig) => config.heartbeatMs * 4;

/** Thrown at startup for a setup queue mode can't run on. */
export class ClusterConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClusterConfigError';
  }
}

/**
 * Refuse a setup queue mode can't run on: SQLite without the single-host override (workers on other hosts can't share
 * the file). Returns the warnings to log (the filesystem binary store across hosts).
 */
export function checkClusterConfig(config: ClusterConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  if (config.mode !== 'queue') {
    if (config.role === 'worker') throw new ClusterConfigError('A worker needs queue mode: set LANDFLOW_EXECUTIONS_MODE=queue (and LANDFLOW_VALKEY_URL)');
    return [];
  }
  if (config.cluster && config.sentinel) throw new ClusterConfigError('Set LANDFLOW_VALKEY_CLUSTER or LANDFLOW_VALKEY_SENTINELS, not both: a cluster has no sentinels, and Sentinel is a single primary.');
  const postgres = env.LANDFLOW_DB?.trim().toLowerCase() === 'postgres';
  if (!postgres && !config.allowSqlite) {
    throw new ClusterConfigError(
      'Queue mode needs Postgres (LANDFLOW_DB=postgres and DATABASE_URL): mains and workers on other hosts cannot share a SQLite file. ' +
        'To run every main and worker on this one host with one SQLite file, set LANDFLOW_QUEUE_ALLOW_SQLITE=true.',
    );
  }
  const warnings: string[] = [];
  if ((env.LANDFLOW_BINARY_STORE ?? 'filesystem').trim().toLowerCase() !== 's3') {
    warnings.push(
      'Queue mode with the filesystem binary store: mains and workers on other hosts cannot read each other’s files. Use LANDFLOW_BINARY_STORE=s3 (S3 or MinIO), or share LANDFLOW_BINARY_DIR between every main and worker.',
    );
  }
  if (!env.LANDFLOW_ENCRYPTION_KEY?.trim()) {
    warnings.push('Queue mode without LANDFLOW_ENCRYPTION_KEY: every main and worker must decrypt the same credentials, so set the same key everywhere.');
  }
  if (!env.LANDFLOW_BINARY_SECRET?.trim()) {
    warnings.push('Queue mode without LANDFLOW_BINARY_SECRET: a plugin given a file link by a worker fetches it from a main, so every process must sign those links with the same secret.');
  }
  if (postgres && !config.stableId) {
    warnings.push('Postgres mode without LANDFLOW_INSTANCE_ID: set a stable name per process so a restart replays its own write spool.');
  }
  return warnings;
}
