/**
 * Queue mode metrics (OTel, scope landflow-host; also on /metrics):
 *
 * - `landflow.cluster.instance` (gauge, 1): this process, by `landflow.cluster.role` and `landflow.cluster.leader`;
 * - `landflow.cluster.workers` (gauge): workers with a current heartbeat;
 * - `landflow.queue.depth` / `landflow.queue.active` (gauges): jobs no worker took yet / jobs workers hold;
 * - `landflow.worker.active_jobs` (gauge): runs this process is running now;
 * - `landflow.queue.jobs` (counter, by `landflow.job.outcome`: processed, failed, claimed, recovered, requeued);
 * - `landflow.cluster.leader.elections` (counter): leaderships this main won.
 *
 * The gauges read a snapshot the heartbeat refreshes (observable callbacks can't wait for Valkey).
 */
import { metrics, type Counter, type MeterProvider } from '@opentelemetry/api';
import { HOST_SCOPE } from '../telemetry/metrics';
import { clusterState } from './state';

export interface ClusterSnapshot {
  workers: number;
  mains: number;
  depth: number;
  active: number;
  leader: boolean;
}

const snapshot: ClusterSnapshot = { workers: 0, mains: 0, depth: 0, active: 0, leader: false };

export function updateSnapshot(next: Partial<ClusterSnapshot>) {
  Object.assign(snapshot, next);
}

export const clusterSnapshot = (): ClusterSnapshot => ({ ...snapshot });

let instruments: { provider: MeterProvider; jobs: Counter; elections: Counter } | undefined;

function ensure() {
  const provider = metrics.getMeterProvider();
  if (instruments?.provider === provider) return instruments;
  const meter = provider.getMeter(HOST_SCOPE);
  const state = clusterState;
  meter.createObservableGauge('landflow.cluster.instance', { description: 'This Landflow process in queue mode, by role and leadership' }).addCallback((result) => {
    const { config } = state();
    result.observe(1, { 'landflow.cluster.role': config.role, 'landflow.cluster.leader': config.role === 'main' && snapshot.leader });
  });
  meter.createObservableGauge('landflow.cluster.workers', { description: 'Workers with a current heartbeat' }).addCallback((result) => result.observe(snapshot.workers));
  meter.createObservableGauge('landflow.queue.depth', { description: 'Jobs in the queue that no worker took yet' }).addCallback((result) => result.observe(snapshot.depth));
  meter.createObservableGauge('landflow.queue.active', { description: 'Jobs workers hold now' }).addCallback((result) => result.observe(snapshot.active));
  meter.createObservableGauge('landflow.worker.active_jobs', { description: 'Runs this process is running now' }).addCallback((result) => {
    const { config, activeJobs } = state();
    result.observe(activeJobs.size, { 'landflow.cluster.role': config.role });
  });
  instruments = {
    provider,
    jobs: meter.createCounter('landflow.queue.jobs', { description: 'Queue jobs by outcome (processed, failed, claimed, recovered, requeued)' }),
    elections: meter.createCounter('landflow.cluster.leader.elections', { description: 'Leaderships this main won' }),
  };
  return instruments;
}

/** Register the gauges (once per meter provider). */
export function observeCluster() {
  ensure();
}

export type JobOutcome = 'processed' | 'failed' | 'claimed' | 'recovered' | 'requeued';

export function recordJob(outcome: JobOutcome) {
  ensure().jobs.add(1, { 'landflow.job.outcome': outcome });
}

export function recordElection() {
  ensure().elections.add(1);
}
