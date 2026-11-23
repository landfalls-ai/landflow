/**
 * `landflow.sse.connections` is labelled by route template, never by request path (lib/server/sse.ts). About one id in
 * six has no digit (`wf_` + nanoid(10), `ex_` + nanoid(12)), so a path heuristic left such ids in the label and every
 * run stream of those workflows added a series that lived as long as the process.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { metrics } from '@opentelemetry/api';
import { MeterProvider, MetricReader, type DataPoint } from '@opentelemetry/sdk-metrics';
import type { Workflow, WorkflowNode } from '@landflow/engine';

class TestReader extends MetricReader {
  protected async onForceFlush() {}
  protected async onShutdown() {}
}
const reader = new TestReader();
metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-sse-label-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_PUBLIC_URL: 'http://label.test' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { sseResponse, UNNAMED_ROUTE } = await import('@/lib/server/sse');
const { eventStream } = await import('@/lib/server/events-stream');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const runRoute = await import('@/app/api/workflows/[id]/run/route');

registry.registerBuiltin(corePlugin);

afterAll(() => {
  metrics.disable();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

async function labels(): Promise<Map<string, number>> {
  const { resourceMetrics } = await reader.collect();
  const points = resourceMetrics.scopeMetrics
    .flatMap((scope) => scope.metrics)
    .filter((metric) => metric.descriptor.name === 'landflow.sse.connections')
    .flatMap((metric) => metric.dataPoints as DataPoint<number>[]);
  return new Map(points.map((point) => [String(point.attributes['http.route']), Number(point.value)]));
}

const node = (id: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters });

describe('landflow.sse.connections labels', () => {
  it('labels a run stream of a workflow whose id has no digit by its route template', async () => {
    const id = 'wf_AbCdEfGhIj';
    const workflow: Workflow = {
      id,
      name: id,
      nodes: [node('Start', 'core.manualTrigger'), node('Wait', 'core.wait', { seconds: 1 })],
      connections: [{ id: 'e', type: 'main', source: 'Start', target: 'Wait', sourceIndex: 0, targetIndex: 0 }],
    };
    store.saveWorkflow(workflow);
    const leave = new AbortController();
    const response = await runRoute.POST(
      new Request(`http://label.test/api/workflows/${id}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: leave.signal }),
      { params: Promise.resolve({ id }) },
    );
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const open = await labels();
    expect(open.get('/api/workflows/:id/run')).toBe(1);
    expect([...open.keys()].some((label) => label.includes('AbCdEfGhIj'))).toBe(false);
    leave.abort();
    await response.body?.cancel().catch(() => {});
    expect((await labels()).get('/api/workflows/:id/run')).toBe(0);
  });

  it('labels the event stream /api/events', async () => {
    const leave = new AbortController();
    const response = eventStream(new Request('http://label.test/api/events', { signal: leave.signal }), { authorize: () => () => true, heartbeatMs: 0 });
    expect((await labels()).get('/api/events')).toBe(1);
    leave.abort();
    await response.body?.cancel().catch(() => {});
    expect((await labels()).get('/api/events')).toBe(0);
  });

  it('falls back to a fixed label, never the path, when a caller names no route', async () => {
    const leave = new AbortController();
    const response = sseResponse(new Request('http://label.test/api/executions/ex_AbCdEfGhIjKl/stream', { signal: leave.signal }), () => {}, { heartbeatMs: 0 });
    const open = await labels();
    expect(open.get(UNNAMED_ROUTE)).toBe(1);
    expect([...open.keys()].some((label) => label.includes('AbCdEfGhIjKl'))).toBe(false);
    leave.abort();
    await response.body?.cancel().catch(() => {});
  });
});
