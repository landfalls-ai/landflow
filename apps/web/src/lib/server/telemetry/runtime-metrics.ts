/**
 * Process saturation metrics (docs/observability.md §5): event-loop delay and utilisation, memory and garbage
 * collection. Hand-rolled on perf_hooks, no dependency. The event-loop histogram is read and reset at collection
 * (at most once a second, so a Prometheus scrape and an OTLP export see the same window instead of splitting it).
 */
import { monitorEventLoopDelay, PerformanceObserver, constants, performance, type EventLoopUtilization, type IntervalHistogram } from 'node:perf_hooks';
import type { Meter } from '@opentelemetry/api';
import { singleton } from '../singleton';
import { hostMetrics } from './metrics';

const GC_KINDS: Record<number, string> = {
  [constants.NODE_PERFORMANCE_GC_MAJOR]: 'major',
  [constants.NODE_PERFORMANCE_GC_MINOR]: 'minor',
  [constants.NODE_PERFORMANCE_GC_INCREMENTAL]: 'incremental',
  [constants.NODE_PERFORMANCE_GC_WEAKCB]: 'weakcb',
};

/** Register the instruments on `meter`; returns what stops the sampling. `recordGc` receives each pause (ms) and its kind. */
export function observeRuntime(meter: Meter, recordGc: (ms: number, kind: string) => void): () => void {
  const loop: IntervalHistogram = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  let window = { p50: 0, p99: 0, max: 0 };
  let readAt = 0;
  let previous: EventLoopUtilization = performance.eventLoopUtilization();
  let utilization = 0;
  const refresh = () => {
    const now = Date.now();
    if (now - readAt < 1000) return;
    readAt = now;
    // The histogram is empty when nothing ran since the last reset; keep the last window then.
    if (loop.count > 0) window = { p50: loop.percentile(50) / 1e6, p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 };
    loop.reset();
    const current = performance.eventLoopUtilization();
    utilization = performance.eventLoopUtilization(current, previous).utilization;
    previous = current;
  };

  meter
    .createObservableGauge('landflow.runtime.event_loop.delay', { description: 'Event-loop delay since the last collection, by quantile (p50, p99, max)', unit: 'ms' })
    .addCallback((result) => {
      refresh();
      for (const [quantile, value] of Object.entries(window)) result.observe(value, { 'landflow.quantile': quantile });
    });
  meter
    .createObservableGauge('landflow.runtime.event_loop.utilization', { description: 'Share of time the event loop was busy since the last collection (0 to 1)', unit: '1' })
    .addCallback((result) => {
      refresh();
      result.observe(utilization);
    });
  meter.createObservableGauge('landflow.runtime.memory', { description: 'Process memory by type (heap_used, heap_total, rss)', unit: 'By' }).addCallback((result) => {
    const usage = process.memoryUsage();
    result.observe(usage.heapUsed, { 'landflow.memory.type': 'heap_used' });
    result.observe(usage.heapTotal, { 'landflow.memory.type': 'heap_total' });
    result.observe(usage.rss, { 'landflow.memory.type': 'rss' });
  });

  let gc: PerformanceObserver | undefined;
  try {
    gc = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const kind = (entry as unknown as { detail?: { kind?: number } }).detail?.kind ?? (entry as unknown as { kind?: number }).kind;
        recordGc(entry.duration, GC_KINDS[kind ?? -1] ?? 'other');
      }
    });
    gc.observe({ entryTypes: ['gc'] });
  } catch {
    gc = undefined; // a runtime without GC entries: the other instruments still report
  }
  return () => {
    loop.disable();
    gc?.disconnect();
  };
}

/** Start once per process (telemetry/sdk.ts, when telemetry is on). */
export function startRuntimeMetrics(): void {
  singleton('runtime-metrics', () => {
    const { meter, gcDuration } = hostMetrics();
    return observeRuntime(meter, (ms, kind) => gcDuration.record(ms, { 'landflow.gc.kind': kind }));
  });
}
