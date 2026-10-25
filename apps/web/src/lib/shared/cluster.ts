/** Queue mode as Settings → Workers shows it (GET /api/settings/workers, lib/server/cluster). */

/** A main or worker, as its heartbeat describes it. */
export interface ClusterInstance {
  id: string;
  role: 'main' | 'worker';
  hostname: string;
  pid: number;
  startedAt: string;
  lastSeen: string;
  /** Runs going in this process now. */
  active: number;
  /** Workers: how many runs it takes at once. */
  concurrency?: number;
  /** Workers: jobs finished since it started. */
  processed?: number;
  /** Mains: whether it holds the leadership. */
  leader?: boolean;
  /** Mains: runs it waits for a worker to finish (webhook calls, forms, chats). */
  awaiting?: number;
  version?: string;
  /** Workers: where its health endpoint listens. */
  port?: number;
  /** Stopping (SIGTERM): it takes no new jobs. */
  draining?: boolean;
}

export interface ClusterStatus {
  mode: 'regular' | 'queue';
  /** The process that answered. */
  self: { id: string; role: 'main' | 'worker'; active: number; processed?: number; concurrency?: number; leader?: boolean; startedAt: string };
  coordinator?: 'valkey' | 'memory';
  database: 'sqlite' | 'postgres';
  /** Who leads, and the fencing token of that leadership. */
  leader?: { holder?: string; token: number };
  /** Jobs no worker took yet, and jobs workers hold. */
  queue?: { waiting: number; active: number };
  instances?: ClusterInstance[];
  settings?: { concurrency: number; offloadManual: boolean; leaderTtlSeconds: number; stalledSeconds: number; prefix: string };
}
