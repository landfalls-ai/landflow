/**
 * Metrics of the Postgres write queue (docs/observability.md §5): the queue's depth and age, whether it is blocked on a
 * batch Postgres rejects, and counters of rejections and blocked retries. Gauges read the open sink's health when
 * scraped; the counters are recorded by the sink as it fails and retries.
 */
import { metrics, type Counter, type MeterProvider } from '@opentelemetry/api';
import { HOST_SCOPE, hostMetrics } from '../telemetry/metrics';
import type { WriteHealth } from './database';

let source: (() => WriteHealth) | undefined;
let registered: MeterProvider | undefined;

/** Report `health` through the queue gauges until the returned function is called (the gauges are created once per meter provider). */
export function registerWriteMetrics(health: () => WriteHealth): () => void {
  source = health;
  const provider = metrics.getMeterProvider();
  if (registered !== provider) {
    registered = provider;
    const meter = provider.getMeter(HOST_SCOPE);
    const batches = meter.createObservableGauge('landflow.db.write_queue.batches', { description: 'Write batches queued for Postgres and not yet applied' });
    const age = meter.createObservableGauge('landflow.db.write_queue.oldest_age', { description: 'Age of the oldest write batch not yet in Postgres', unit: 's' });
    const blocked = meter.createObservableGauge('landflow.db.write_blocked', { description: '1 while the store refuses writes because Postgres rejects a batch' });
    meter.addBatchObservableCallback(
      (result) => {
        const h = source?.();
        if (!h) return;
        result.observe(batches, h.queuedBatches);
        result.observe(age, h.oldestAgeMs / 1000);
        result.observe(blocked, h.state === 'blocked' ? 1 : 0);
      },
      [batches, age, blocked],
    );
  }
  return () => {
    if (source === health) source = undefined;
  };
}

/** The two counters, created once per meter provider like hostMetrics()' own instruments. */
let counters: { meter: unknown; rejections: Counter; retries: Counter } | undefined;
function writeCounters() {
  const { meter } = hostMetrics();
  if (counters?.meter !== meter) {
    counters = {
      meter,
      rejections: meter.createCounter('landflow.db.write_rejections', { description: 'Write batches Postgres rejected (not connection failures)' }),
      retries: meter.createCounter('landflow.db.write_retries', { description: 'Retries of a blocked write batch' }),
    };
  }
  return counters;
}

/** A batch Postgres rejected with a non-connection error. */
export const recordWriteRejection = () => writeCounters().rejections.add(1);
/** A retry of a blocked batch. */
export const recordWriteRetry = () => writeCounters().retries.add(1);
