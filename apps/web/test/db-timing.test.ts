import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { context, metrics, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { MeterProvider, MetricReader, type DataPoint } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';

class TestReader extends MetricReader {
  protected async onForceFlush() {}
  protected async onShutdown() {}
}
const reader = new TestReader();
const spans = new InMemorySpanExporter();
process.env.LANDFLOW_DB_SLOW_MS = '40';
metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: spans })] }));
const { openSqlite, statementName, Database } = await import('@/lib/server/db/database');

beforeAll(() => context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable()));
afterAll(() => {
  trace.disable();
  metrics.disable();
  context.disable();
});
beforeEach(() => spans.reset());

async function counts() {
  const { resourceMetrics } = await reader.collect();
  const found = resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics).find((m) => m.descriptor.name === 'landflow.db.query.duration');
  return Object.fromEntries((found?.dataPoints as DataPoint<{ count: number }>[] | undefined)?.map((point) => [String(point.attributes['db.operation']), point.value.count]) ?? []);
}

describe('database timing', () => {
  it('records a histogram per operation, with no SQL text in the labels', async () => {
    const db = openSqlite(':memory:');
    db.upsert('settings', { key: 'a', value: '1' } as never);
    db.get('SELECT * FROM settings WHERE key = ?', 'a');
    db.all('SELECT * FROM settings');
    db.delete('settings', { key: 'a' });
    const by = await counts();
    expect(by).toMatchObject({ upsert: 1, delete: 1 });
    expect(by.select).toBeGreaterThanOrEqual(2);
    expect(spans.getFinishedSpans().filter((span) => span.name === 'db.query')).toHaveLength(0);
    await db.close();
  });

  it('opens a db.query span only for calls over the threshold', async () => {
    const db = openSqlite(':memory:');
    db.all('SELECT 1');
    expect(spans.getFinishedSpans()).toHaveLength(0);
    // A recursive query that takes well over 40 ms.
    const sql = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 3000000) SELECT count(*) AS n FROM c WHERE x > 'abc' OR x > 5";
    db.all(sql);
    const [span] = spans.getFinishedSpans().filter((s) => s.name === 'db.query');
    expect(span.attributes['db.system']).toBe('sqlite');
    expect(span.attributes['db.operation']).toBe('select');
    expect(String(span.attributes['db.query.summary'])).toHaveLength(60);
    await db.close();
  });

  it('strips literals from the statement name', () => {
    expect(statementName("SELECT * FROM t WHERE a = 'x''y' AND b = 42   AND c = ?")).toBe('SELECT * FROM t WHERE a = ? AND b = ? AND c = ?');
    expect(statementName('x'.repeat(100))).toHaveLength(60);
  });

  it('gives Postgres direct() calls a span', async () => {
    const sink = { enqueue() {}, flush: async () => {}, close: async () => {}, direct: async <T,>(fn: (client: never) => Promise<T>) => fn({} as never) };
    const db = new Database((openSqlite(':memory:')).sqlite, 'postgres', ':memory:', sink);
    expect(await db.direct(async () => 7)).toBe(7);
    const [span] = spans.getFinishedSpans().filter((s) => s.name === 'db.query');
    expect(span.attributes).toMatchObject({ 'db.system': 'postgresql', 'db.operation': 'direct' });
  });
});
