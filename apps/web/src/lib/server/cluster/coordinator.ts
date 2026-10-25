/**
 * What queue mode needs from Valkey, as one interface with two implementations: ./valkey (Redis Streams with a consumer
 * group, Lua scripts for the atomic parts) and ./memory (an in-process double with the same semantics, for tests and
 * for trying the cluster code without a server).
 *
 * Why a small Streams queue rather than BullMQ: the execution row in the database is already the job record (status,
 * input, checkpoints, retries, the concurrency queue), so the queue only has to carry "run this execution" messages.
 * A consumer group gives at-least-once delivery, a pending list per worker, XCLAIM heartbeats and XAUTOCLAIM to take
 * over a dead worker's messages; crash recovery then continues from the run's checkpoint. BullMQ would keep a second
 * copy of each job's state (and its retries) next to the execution row, and bring ioredis and its Lua scripts along.
 */
import type { Workflow } from '@landflow/engine';
import type { ClusterInstance } from '../../shared/cluster';
import type { ExecutionRecord } from '../../shared/types';

/** Engine options a job carries (the serializable part of ExecuteWorkflowOptions: start, partial and resume state). */
export type JobEngineOptions = Record<string, unknown>;

/** "Run this stretch of an execution": built by a main (or a worker) and taken by a worker. */
export interface QueueJob {
  executionId: string;
  workflowId: string;
  /**
   * What the stored execution must be for this job to start: `queued` (a new run), `waiting` (a resume) or `running`
   * (a run whose process stopped: it continues from its last checkpoint).
   */
  expect: 'queued' | 'waiting' | 'running';
  /** The record as the runner builds it before its first node (a resume: with the run data so far). */
  record: ExecutionRecord;
  /** The graph it runs. */
  workflow: Workflow;
  engine: JobEngineOptions;
  /** The instance that waits for the result: events, replies and the outcome go to its inbox. */
  origin?: string;
  /** Send every engine event to the origin (a caller with onEvent: the editor, a streaming webhook or chat). */
  events?: boolean;
  /** The engine streams node chunks (ctx.sendChunk). */
  streaming?: boolean;
  /** The origin waits for a reply (Respond to Webhook, a form's end screen). */
  replies?: boolean;
  /** W3C trace context of the trigger: the run continues its trace. */
  trace?: Record<string, string>;
  enqueuedAt: string;
}

export interface Delivery {
  /** The stream entry id. */
  id: string;
  job: QueueJob;
}

/** A concurrency rule for admit/drain (from the workflow settings, lib/server/concurrency.ts). */
export interface SlotRule {
  /** Runs at once; Infinity = unlimited. */
  slots: number;
  /** Waiting runs that hold a slot (singleton mode). */
  waiting: number;
  /** When full: queue (FIFO) or skip. */
  overflow: 'queue' | 'skip';
  /** Queue size limit. */
  queueSize: number;
}

export type AdmitResult = 'run' | 'queue' | 'skip' | 'full';

/** A process in the cluster, as its heartbeat describes it. */
export type InstanceInfo = ClusterInstance;

export interface Leadership {
  /** Who leads now (undefined: nobody). */
  holder?: string;
  /** Fencing token: grows with every new leadership. */
  token: number;
  /** Whether the caller leads. */
  mine: boolean;
}

export interface Coordinator {
  readonly kind: 'valkey' | 'memory';

  // ---- job queue ------------------------------------------------------------
  /** Add a job; resolves with its id. */
  enqueue(job: QueueJob): Promise<string>;
  /** Up to `count` new jobs for `consumer`, waiting up to `blockMs` for the first. */
  take(consumer: string, count: number, blockMs: number): Promise<Delivery[]>;
  /** Done with a job: it leaves the queue. */
  ack(id: string): Promise<void>;
  /** Jobs `consumer` still works on: resets their idle time so nobody takes them over. */
  touch(consumer: string, ids: string[]): Promise<void>;
  /** Take over jobs idle for at least `minIdleMs` (their consumer stopped touching them: it died). */
  claimStalled(consumer: string, minIdleMs: number, count: number): Promise<Delivery[]>;
  /** Put a job back at the end of the queue and drop this delivery (a worker shutting down). */
  requeue(delivery: Delivery): Promise<void>;
  /** Jobs nobody took yet, and jobs a worker holds. */
  queueStats(): Promise<{ waiting: number; active: number }>;

  // ---- keys with a time to live (leases, claims, markers) ------------------
  /** Set `key` unless it exists; true when set. */
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  /** Several keys at once (missing: undefined). */
  getMany(keys: string[]): Promise<Array<string | undefined>>;
  /** Set several keys with one time to live (lease renewals). */
  setMany(entries: Array<[string, string]>, ttlMs: number): Promise<void>;
  /** Renew `key` only while it holds `value`. */
  extendIfValue(key: string, value: string, ttlMs: number): Promise<boolean>;
  /** Delete `key` only while it holds `value`. */
  deleteIfValue(key: string, value: string): Promise<boolean>;
  del(...keys: string[]): Promise<void>;
  /** Add 1 and return the new value; the key expires `ttlMs` after its first increment. */
  incr(key: string, ttlMs: number): Promise<number>;

  // ---- leader election -----------------------------------------------------
  /** Take the leadership if it is free, or renew it if `id` holds it (one atomic step). */
  campaign(id: string, ttlMs: number): Promise<Leadership>;
  /** Give the leadership up (only if `id` holds it). */
  resign(id: string): Promise<void>;
  leadership(): Promise<Leadership>;

  // ---- per-workflow concurrency across processes ---------------------------
  /** May this run start now (its slot is taken), wait in the FIFO queue, or is it skipped? Expired slots free first. */
  admit(workflowId: string, executionId: string, rule: SlotRule, leaseMs: number): Promise<AdmitResult>;
  /** Add a run to the workflow's FIFO queue (score: when it was queued). */
  addToQueue(workflowId: string, executionId: string, queuedAtMs: number): Promise<void>;
  /** Take a slot whatever the limit (retries, resumes and recovered runs), or renew one. */
  holdSlots(entries: Array<{ workflowId: string; executionId: string }>, leaseMs: number): Promise<void>;
  releaseSlot(workflowId: string, executionId: string): Promise<void>;
  /** Move queued runs into free slots, oldest first; returns their ids. */
  drain(workflowId: string, rule: SlotRule, leaseMs: number): Promise<string[]>;
  /** Drop a run from the FIFO queue (canceled). */
  removeFromQueue(workflowId: string, executionId: string): Promise<void>;
  /** Whether a run is in the FIFO queue. */
  isQueued(workflowId: string, executionId: string): Promise<boolean>;
  slotUsage(workflowId: string): Promise<{ running: number; queued: number }>;
  /** Sliding-window rate limit: 0 when a call may go now (it is counted), else how many ms to wait. */
  rateLimit(key: string, limit: number, intervalMs: number): Promise<number>;

  // ---- pub/sub ---------------------------------------------------------------
  publish(channel: string, message: string): Promise<void>;
  /** Resolves once subscribed; the result unsubscribes. */
  subscribe(channel: string, handler: (message: string) => void): Promise<() => Promise<void>>;

  // ---- instances -------------------------------------------------------------
  heartbeat(info: InstanceInfo, ttlMs: number): Promise<void>;
  /** Instances whose heartbeat is current. */
  instances(): Promise<InstanceInfo[]>;
  forget(id: string): Promise<void>;

  close(): Promise<void>;
}
