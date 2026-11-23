import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { metrics } from '@opentelemetry/api';
import { MeterProvider, MetricReader, type DataPoint } from '@opentelemetry/sdk-metrics';

class TestReader extends MetricReader {
  protected async onForceFlush() {}
  protected async onShutdown() {}
}
const reader = new TestReader();
process.env.LANDFLOW_METRICS_WORKFLOW_LABEL = '';
const meterProvider = new MeterProvider({ readers: [reader] });
metrics.setGlobalMeterProvider(meterProvider);

const { observeRuntime } = await import('@/lib/server/telemetry/runtime-metrics');
const { hostMetrics, recordScheduleLag, recordWebhookRequest, recordRuntimeEvent } = await import('@/lib/server/telemetry/metrics');
const { AttemptLimiter } = await import('@/lib/server/auth/rate-limit');
const { sseResponse } = await import('@/lib/server/sse');

async function points(name: string) {
  const { resourceMetrics } = await reader.collect();
  return resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics).filter((m) => m.descriptor.name === name).flatMap((m) => m.dataPoints as DataPoint<number>[]);
}
const sum = (list: DataPoint<number>[]) => list.reduce((total, point) => total + Number(point.value), 0);

let stop: () => void;
beforeAll(() => {
  stop = observeRuntime(hostMetrics().meter, (ms, kind) => hostMetrics().gcDuration.record(ms, { 'landflow.gc.kind': kind }));
});
afterAll(() => {
  stop();
  metrics.disable();
});

describe('runtime metrics', () => {
  it('reports event-loop delay by quantile, utilisation and memory', async () => {
    // Block the loop a little so the delay histogram has a sample.
    await new Promise((resolve) => setTimeout(resolve, 60));
    const end = Date.now() + 40;
    while (Date.now() < end);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const delay = await points('landflow.runtime.event_loop.delay');
    expect(delay.map((point) => point.attributes['landflow.quantile']).sort()).toEqual(['max', 'p50', 'p99']);
    expect(delay.find((point) => point.attributes['landflow.quantile'] === 'max')!.value).toBeGreaterThan(0);
    const utilization = await points('landflow.runtime.event_loop.utilization');
    expect(utilization).toHaveLength(1);
    expect(Number(utilization[0].value)).toBeGreaterThanOrEqual(0);
    expect(Number(utilization[0].value)).toBeLessThanOrEqual(1);
    const memory = await points('landflow.runtime.memory');
    expect(memory.map((point) => point.attributes['landflow.memory.type']).sort()).toEqual(['heap_total', 'heap_used', 'rss']);
    expect(memory.every((point) => Number(point.value) > 0)).toBe(true);
  });

  it('reports an idle loop near zero and a blocked loop as roughly the blocked time', async () => {
    const quantile = async (name: string) => Number((await points('landflow.runtime.event_loop.delay')).find((point) => point.attributes['landflow.quantile'] === name)!.value);
    // Let the window roll over, then sit idle: the sampling interval itself must not show as delay.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await points('landflow.runtime.event_loop.delay');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(await quantile('p50')).toBeLessThan(8);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const end = Date.now() + 300;
    while (Date.now() < end);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const max = await quantile('max');
    expect(max).toBeGreaterThan(200);
    expect(max).toBeLessThan(500);
  });

  it('records garbage collection pauses by kind', async () => {
    const gc = (globalThis as { gc?: () => void }).gc;
    // Allocate until the engine collects (a scavenge) instead of needing --expose-gc.
    let keep: unknown[] = [];
    for (let i = 0; i < 200 && !(await points('landflow.runtime.gc.duration')).length; i++) {
      for (let j = 0; j < 20_000; j++) keep.push({ j, text: 'x'.repeat(50) });
      keep = [];
      gc?.();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const recorded = await points('landflow.runtime.gc.duration');
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.every((point) => typeof point.attributes['landflow.gc.kind'] === 'string')).toBe(true);
  });
});

describe('workflow label', () => {
  it('is off the instruments by default and on the counters only with the switch', async () => {
    recordScheduleLag(12);
    recordWebhookRequest(200, 'wf_1');
    recordRuntimeEvent('queued', 'wf_1');
    const labelled = async (name: string) => (await points(name)).some((point) => 'landflow.workflow.id' in point.attributes);
    expect(await labelled('landflow.webhook.requests')).toBe(false);
    expect(await labelled('landflow.runtime.events')).toBe(false);
    expect(await labelled('landflow.schedule.lag')).toBe(false);
    expect(sum(await points('landflow.webhook.requests'))).toBe(1);

    process.env.LANDFLOW_METRICS_WORKFLOW_LABEL = 'true';
    try {
      recordWebhookRequest(200, 'wf_2');
      recordRuntimeEvent('queued', 'wf_2');
      recordScheduleLag(5);
      expect((await points('landflow.webhook.requests')).some((point) => point.attributes['landflow.workflow.id'] === 'wf_2')).toBe(true);
      expect((await points('landflow.runtime.events')).some((point) => point.attributes['landflow.workflow.id'] === 'wf_2')).toBe(true);
      // The histogram never carries it.
      expect(await labelled('landflow.schedule.lag')).toBe(false);
    } finally {
      process.env.LANDFLOW_METRICS_WORKFLOW_LABEL = '';
    }
  });
});

describe('security and saturation counters', () => {
  it('counts failed sign-ins and refusals by limiter', async () => {
    const email = new AttemptLimiter('email', 2, 60_000);
    const ip = new AttemptLimiter('ip', 2, 60_000);
    await email.hit('a@x.test');
    await ip.hit('1.1.1.1');
    await email.hit('a@x.test');
    expect(sum(await points('landflow.auth.sign_in_failures'))).toBe(2);
    expect((await email.check('a@x.test')).ok).toBe(false);
    expect((await ip.check('1.1.1.1')).ok).toBe(true);
    const limited = await points('landflow.auth.limited');
    expect(limited).toHaveLength(1);
    expect(limited[0].attributes['landflow.limiter']).toBe('email');
  });

  it('counts open SSE streams per route and drops them when a stream closes', async () => {
    const controller = new AbortController();
    const response = sseResponse(new Request('http://x.test/api/executions/ex_123/stream', { signal: controller.signal }), () => {}, { heartbeatMs: 0, route: '/api/executions/:id/stream' });
    const open = await points('landflow.sse.connections');
    expect(open.find((point) => point.attributes['http.route'] === '/api/executions/:id/stream')?.value).toBe(1);
    controller.abort();
    const after = await points('landflow.sse.connections');
    expect(after.find((point) => point.attributes['http.route'] === '/api/executions/:id/stream')?.value).toBe(0);
    await response.body?.cancel().catch(() => {});
  });
});
