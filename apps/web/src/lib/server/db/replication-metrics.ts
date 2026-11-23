/**
 * The replication lag gauge (queue mode, docs/observability.md §5): `landflow.db.replication.lag`, in seconds, the time
 * between another process sending a change notice (just before its commit) and this process applying it, as of the
 * last notice applied. A growing value means this process's copy is falling behind the others' writes.
 */
import { metrics, type MeterProvider } from '@opentelemetry/api';
import { HOST_SCOPE } from '../telemetry/metrics';

let source: (() => number) | undefined;
let registered: MeterProvider | undefined;

/** Report `lagMs` through the gauge until the returned function is called (created once per meter provider). */
export function registerReplicationMetrics(lagMs: () => number): () => void {
  source = lagMs;
  const provider = metrics.getMeterProvider();
  if (registered !== provider) {
    registered = provider;
    const gauge = provider.getMeter(HOST_SCOPE).createObservableGauge('landflow.db.replication.lag', { description: 'Seconds between another process sending a change notice and this process applying it (queue mode)', unit: 's' });
    gauge.addCallback((result) => {
      const ms = source?.();
      if (ms !== undefined) result.observe(ms / 1000);
    });
  }
  return () => {
    if (source === lagMs) source = undefined;
  };
}
