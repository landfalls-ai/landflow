/**
 * The job loop of a worker process (`pnpm worker`): it takes up to LANDFLOW_WORKER_CONCURRENCY jobs at once from the
 * Valkey stream and runs each through the runner, as the main that queued it would have.
 *
 * - One process per execution: a job runs under `lease:<execution>` (renewed by the heartbeat, cluster/index.ts). A
 *   duplicate delivery of a job someone else holds is left to its holder.
 * - What the stored execution is decides what a job does: `queued` starts it, `waiting` resumes it, `running` means
 *   its last process stopped mid-run, so it continues from its last checkpoint (at most MAX_TAKEOVERS times), and a
 *   finished or canceled one only reports its result.
 * - Its events, a Respond to Webhook reply and the finished record go to the origin's inbox.
 * - Stalled jobs: a worker that stops touching its jobs (it died) loses them after LANDFLOW_STALLED_SECONDS to a worker
 *   that claims them (XAUTOCLAIM); their runs continue from their checkpoints.
 * - SIGTERM: no new jobs; runs get LANDFLOW_WORKER_SHUTDOWN_SECONDS to finish, the rest go back to the queue (with
 *   their progress saved), and another worker continues them from their last checkpoint.
 */
import { context, propagation, ROOT_CONTEXT } from '@opentelemetry/api';
import type { ExecutionEvent, Workflow } from '@landflow/engine';
import type { ExecutionRecord } from '../../shared/types';
import { LIMITED_MODES } from '../concurrency';
import { database } from '../db';
import { refreshRows } from '../db/replication';
import { cancelQueuedExecution, drainQueue, failExecution, recoverExecution, runJob, type RunReply, type Segment } from '../runner';
import { store } from '../store';
import { logger } from '../telemetry/logger';
import type { ClusterConfig } from './config';
import { leaseMs } from './config';
import type { Coordinator, Delivery, QueueJob } from './coordinator';
import { toWire, type InboxMessage } from './dispatch';
import { recordJob } from './metrics';
import type { Relay } from './relay';
import { clusterState } from './state';

/** How often a run may lose its worker before it is saved as failed. */
export const MAX_TAKEOVERS = 5;
const DAY_MS = 86_400_000;

type Callbacks = Pick<Segment, 'signal' | 'onEvent' | 'onReply' | 'streaming'>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

interface Running {
  delivery: Delivery;
  done: Promise<void>;
}

export class JobWorker {
  private readonly running = new Map<string, Running>();
  /** Jobs handed back to the queue at shutdown: their local run reports nothing and leaves the keys alone. */
  private readonly handedBack = new Set<string>();
  /** Executions a job of this worker runs now. */
  private readonly holding = new Set<string>();
  private stopping = false;
  /** stop() runs once (the signal handler and stopCluster both call it). */
  private stopped?: Promise<number>;
  private loop?: Promise<void>;
  private timers: NodeJS.Timeout[] = [];
  private wake?: () => void;

  constructor(
    private readonly coordinator: Coordinator,
    private readonly relay: Relay,
    private readonly config: ClusterConfig,
    /** Its name in the consumer group (default: the instance id). */
    readonly consumer = config.instanceId,
  ) {}

  /** Jobs being run now. */
  get active(): number {
    return this.running.size;
  }

  start() {
    if (this.loop) return;
    this.loop = this.takeLoop();
    // Keep the jobs this worker runs (a worker that stops touching them loses them).
    const touch = setInterval(() => void this.touch(), this.config.heartbeatMs);
    const claim = setInterval(() => void this.claim(), Math.max(1_000, Math.floor(this.config.stalledMs / 2)));
    for (const timer of [touch, claim]) timer.unref?.();
    this.timers.push(touch, claim);
  }

  private free() {
    return Math.max(0, this.config.workerConcurrency - this.running.size);
  }

  private async takeLoop() {
    while (!this.stopping) {
      if (!this.free()) {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
          setTimeout(resolve, 1_000).unref?.();
        });
        continue;
      }
      let deliveries: Delivery[];
      const asked = Date.now();
      try {
        deliveries = await this.coordinator.take(this.consumer, this.free(), 2_000);
        // An empty answer that came back at once (a closed connection): don't spin.
        if (!deliveries.length && Date.now() - asked < 50) await sleep(200);
      } catch (error) {
        if (this.stopping) break;
        logger.warn('worker: could not read the job queue', { error: (error as Error).message });
        await sleep(1_000);
        continue;
      }
      for (const delivery of deliveries) {
        if (this.stopping) {
          // Taken while stopping: back to the queue.
          await this.coordinator.requeue(delivery).catch(() => {});
          continue;
        }
        this.begin(delivery);
      }
    }
  }

  private async touch() {
    if (!this.running.size) return;
    await this.coordinator.touch(this.consumer, [...this.running.keys()]).catch((error) => logger.debug('worker: could not touch its jobs', { error: (error as Error).message }));
  }

  /** Take over jobs whose worker stopped touching them. */
  async claim(): Promise<number> {
    const free = this.free();
    if (this.stopping || !free) return 0;
    try {
      const deliveries = await this.coordinator.claimStalled(this.consumer, this.config.stalledMs, free);
      for (const delivery of deliveries) {
        if (this.running.has(delivery.id)) continue;
        logger.info('worker: took over a stalled job', { 'landflow.execution.id': delivery.job.executionId, 'landflow.job.id': delivery.id });
        recordJob('claimed');
        this.begin(delivery);
      }
      return deliveries.length;
    } catch (error) {
      logger.debug('worker: could not claim stalled jobs', { error: (error as Error).message });
      return 0;
    }
  }

  private begin(delivery: Delivery) {
    const state = clusterState();
    state.activeJobs.set(delivery.id, delivery.job.executionId);
    const done = this.handle(delivery)
      .catch((error) => logger.warn('worker: job failed', { 'landflow.execution.id': delivery.job.executionId, error: (error as Error).message }))
      .finally(() => {
        this.running.delete(delivery.id);
        state.activeJobs.delete(delivery.id);
        this.wake?.();
      });
    this.running.set(delivery.id, { delivery, done });
  }

  /** Run one job (exported for tests through `handleJob`). */
  async handle(delivery: Delivery): Promise<void> {
    const { job } = delivery;
    const id = job.executionId;
    const me = this.config.instanceId;
    const valkey = this.coordinator;
    const leaseKey = `lease:${id}`;
    const ttl = leaseMs(this.config);
    if (!(await valkey.setIfAbsent(leaseKey, me, ttl))) {
      const holder = await valkey.get(leaseKey);
      // Another process runs this execution: its job stays in the queue until that process is done (or gone).
      if (holder && holder !== me) {
        logger.debug('worker: execution held by another process', { 'landflow.execution.id': id, 'landflow.cluster.holder': holder });
        return;
      }
    }
    // A second job for a run this worker is running already (a duplicate delivery): drop it.
    if (this.holding.has(id)) {
      logger.debug('worker: duplicate job for a run going here', { 'landflow.execution.id': id, 'landflow.job.id': delivery.id });
      await valkey.ack(delivery.id).catch(() => {});
      return;
    }
    this.holding.add(id);
    const send = (message: InboxMessage) => (job.origin ? this.relay.send(job.origin, message) : Promise.resolve());
    let replies: Promise<unknown> = Promise.resolve();
    const callbacks: Callbacks = {
      ...(job.events && { onEvent: (event: ExecutionEvent) => void send({ t: 'event', id, event }) }),
      ...(job.replies && {
        onReply: (reply: RunReply) => {
          replies = replies.then(() => toWire(reply).then((wire) => send({ t: 'reply', id, reply: wire })));
        },
      }),
      ...(job.streaming && { streaming: true }),
    };
    let limited = false;
    try {
      await refreshRows('executions', { id });
      const stored = store.getExecution(id);
      if (!stored) {
        await send({ t: 'rejected', id, message: 'Execution not found', status: 404 });
        return;
      }
      const canceled = Boolean(await valkey.get(`canceled:${id}`));
      limited = LIMITED_MODES.has(stored.mode) && !stored.parentExecutionId && !stored.debug && !canceled && ['queued', 'waiting', 'running'].includes(stored.status);
      if (limited) await valkey.holdSlots([{ workflowId: stored.workflowId, executionId: id }], ttl);
      const finished = await context.with(propagation.extract(ROOT_CONTEXT, job.trace ?? {}), () => this.execute(job, stored, canceled, callbacks));
      // The main reads what this worker saved: in Postgres before the result goes out.
      await database().flush().catch(() => {});
      await replies.catch(() => {});
      if (this.handedBack.has(delivery.id)) return;
      await send({ t: 'done', id, record: finished });
      recordJob('processed');
    } catch (error) {
      recordJob('failed');
      logger.warn('worker: execution failed to run', { 'landflow.execution.id': id, error: (error as Error).message });
      await replies.catch(() => {});
      await send({ t: 'failed', id, message: (error as Error).message });
    } finally {
      if (!this.handedBack.has(delivery.id)) await this.cleanUp(delivery, limited);
      this.holding.delete(id);
    }
  }

  /** A job done: its slot, keys and lease go, and it leaves the queue. */
  private async cleanUp({ id: deliveryId, job }: Delivery, limited: boolean) {
    const valkey = this.coordinator;
    const id = job.executionId;
    if (limited) {
      await valkey.releaseSlot(job.workflowId, id).catch(() => {});
      drainQueue(job.workflowId);
    }
    await valkey.del(`job:${id}`, `resume:${id}`, `run-opts:${id}`).catch(() => {});
    await valkey.deleteIfValue(`lease:${id}`, this.config.instanceId).catch(() => {});
    await valkey.ack(deliveryId).catch(() => {});
    clusterState().processed++;
  }

  /** What a job does, by what the stored execution is now. */
  private async execute(job: QueueJob, stored: ExecutionRecord, canceled: boolean, callbacks: Callbacks): Promise<ExecutionRecord> {
    const id = job.executionId;
    switch (stored.status) {
      case 'queued': {
        if (canceled) {
          cancelQueuedExecution(id);
          return store.getExecution(id) ?? stored;
        }
        const { queued: _queued, ...rest } = job.record;
        const record: ExecutionRecord = { ...rest, status: 'running', startedAt: new Date().toISOString(), finishedAt: '', durationMs: 0 };
        return runJob(record, job.workflow as Workflow, job.engine, callbacks);
      }
      case 'waiting':
        // A resume; else a job whose last worker ran it into waiting before it could report.
        if (job.expect === 'waiting' && !canceled) return runJob(job.record, job.workflow as Workflow, job.engine, callbacks);
        return stored;
      case 'running': {
        // Its process stopped mid-run (or this job is the leader's take-over of an orphaned run).
        const takeovers = await this.coordinator.incr(`attempts:${id}`, DAY_MS);
        if (takeovers > MAX_TAKEOVERS) return failExecution(stored, `The execution was interrupted ${takeovers - 1} times: the process running it stopped each time`);
        recordJob('recovered');
        return recoverExecution(stored, callbacks);
      }
      default:
        return stored;
    }
  }

  /** SIGTERM: take no more jobs, give runs `graceMs` to finish, put the rest back in the queue. Returns how many went back. */
  stop(graceMs = this.config.shutdownMs): Promise<number> {
    this.stopped ??= this.drain(graceMs);
    return this.stopped;
  }

  private async drain(graceMs: number): Promise<number> {
    this.stopping = true;
    clusterState().draining = true;
    this.wake?.();
    const [touch, claim] = this.timers;
    clearInterval(claim);
    const all = Promise.allSettled([...this.running.values()].map((entry) => entry.done));
    await Promise.race([all, sleep(graceMs)]);
    let requeued = 0;
    if (this.running.size) {
      // Their progress is saved (checkpoints), and in Postgres before anyone else reads it.
      await database().flush().catch(() => {});
      for (const { delivery } of [...this.running.values()]) {
        this.handedBack.add(delivery.id);
        await this.coordinator.requeue(delivery).catch(() => {});
        await this.coordinator.deleteIfValue(`lease:${delivery.job.executionId}`, this.config.instanceId).catch(() => {});
        recordJob('requeued');
        requeued++;
      }
      logger.info('worker: runs still going went back to the queue', { 'landflow.jobs.requeued': requeued });
    }
    clearInterval(touch);
    this.timers = [];
    await this.loop?.catch(() => {});
    return requeued;
  }
}
