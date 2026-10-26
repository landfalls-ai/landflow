/**
 * The cluster runtime's process-wide state (pinned to globalThis, like every long-lived service: Next.js compiles
 * routes into separate module graphs). Light on imports, so the runner, the bus and the timer modules can ask
 * `clusterActive()` without loading the rest of the cluster code.
 */
import { singleton } from '../singleton';
import { clusterConfig, leaseMs, type ClusterConfig } from './config';
import type { Coordinator, InstanceInfo } from './coordinator';
import type { DebugControl } from './debug';
import type { LeaderElector } from './leader';
import type { Relay } from './relay';

/** What processes ask each other on the `control` channel. */
export type ControlMessage =
  | { t: 'cancel'; id: string }
  | { t: 'stop-all' }
  /** For the leader: arm this execution's wait timer, this retry, this held trigger buffer. */
  | { t: 'wait'; id: string }
  | { t: 'retry'; id: string }
  | { t: 'buffer'; key: string }
  /** The installed marketplace node plugins changed: every process runs what is installed now. */
  | { t: 'marketplace' }
  /** A test URL's listener was replaced (the trigger listens again): the main holding its stream ends it (../test-webhooks.ts). */
  | { t: 'listener-replaced'; id: string }
  /** A debugger command for a session another main may hold (./debug.ts). */
  | DebugControl;

export interface ClusterState {
  config: ClusterConfig;
  coordinator?: Coordinator;
  relay?: Relay;
  elector?: LeaderElector;
  /** Queue mode is running: the hooks in the runner, the bus and the timers act. */
  started: boolean;
  startedAt: string;
  /** Workers: jobs finished, and the jobs being run now (stream id → execution id). */
  processed: number;
  activeJobs: Map<string, string>;
  /** Stopping (SIGTERM). */
  draining: boolean;
  /** What stops the cluster runtime (timers, connections). */
  stoppers: Array<() => void | Promise<void>>;
  /** Workers: the job loop. */
  worker?: { readonly active: number; stop(graceMs?: number): Promise<number> };
  /** Hands a timer to the leader (set by startCluster). */
  forward?: (message: Extract<ControlMessage, { t: 'wait' | 'retry' | 'buffer' }>) => void;
}

export const clusterState = () =>
  singleton<ClusterState>('cluster-state', () => ({
    config: clusterConfig(),
    started: false,
    startedAt: new Date().toISOString(),
    processed: 0,
    activeJobs: new Map(),
    draining: false,
    stoppers: [],
  }));

/** Whether queue mode is running in this process. */
export function clusterActive(): boolean {
  const state = clusterState();
  return state.started && state.config.mode === 'queue';
}

/** Whether this process may run the leader's services now: always outside queue mode, else only the elected main. */
export function leads(): boolean {
  if (!clusterActive()) return true;
  return Boolean(clusterState().elector?.isLeader());
}

/** Queue mode on a process that doesn't lead: timers (waits, retries, held trigger events) are the leader's to keep. */
export function delegated(): boolean {
  return clusterActive() && !leads();
}

/** Hand a timer to the leader (it reads the row from the database and arms it). */
export function forwardToLeader(message: Extract<ControlMessage, { t: 'wait' | 'retry' | 'buffer' }>) {
  clusterState().forward?.(message);
}

/** The coordinator of a running cluster (throws outside queue mode). */
export function coordinator(): Coordinator {
  const current = clusterState().coordinator;
  if (!current || !clusterActive()) throw new Error('Queue mode is not running');
  return current;
}

export const instanceId = () => clusterState().config.instanceId;
export const runLeaseMs = () => leaseMs(clusterState().config);

export type { InstanceInfo };
