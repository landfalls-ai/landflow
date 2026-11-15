/**
 * Join test (wave 11, carryover §2): SP01's metrics ↔ SP04's dashboards and alert rules. SP04 checked its queries
 * against instrument names in the source text; here a real model call (the Anthropic adapter against a fake server
 * answering cache numbers) runs under an in-memory metric reader, and every AI metric, label and label value the
 * dashboard (both copies) and `prometheus-rules.yml` query must be among what was emitted, under the names the
 * Prometheus exporter writes (dots to underscores, the unit, `_total` on counters, as exception-fingerprint.test.ts maps them).
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { metrics } from '@opentelemetry/api';
import { AggregationTemporality, DataPointType, MeterProvider, MetricReader, type MetricData } from '@opentelemetry/sdk-metrics';
import { parse } from 'yaml';
import { startFakeModels } from './fake-ai-services';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-spend-metrics-join-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

class TestReader extends MetricReader {
  constructor() {
    super({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE });
  }
  protected async onForceFlush() {}
  protected async onShutdown() {}
}
const reader = new TestReader();
// Set before the host's instruments are made (telemetry/metrics.ts makes them on first use from the global provider).
metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));

const { anthropicModel } = await import('@/lib/server/nodes/models');
const { aiUsageMeter, executionScope, runInUsageScope, savePriceOverrides } = await import('@/lib/server/ai-usage');
const { withCallPurpose } = await import('@/lib/server/ai-usage/call-context');

const fake = await startFakeModels({ reply: () => ({ text: 'ok', usage: { input: 300, output: 20, cacheRead: 900, cacheWrite: 120 } }) });

const root = resolve(__dirname, '../../..');
const sources = [
  'deploy/observability/landflow-dashboard.json',
  'deploy/k8s/components/observability/landflow-dashboard.json',
  'deploy/observability/prometheus-rules.yml',
  'deploy/k8s/components/observability/prometheus-rules.yml',
].map((path) => ({ path, text: readFileSync(join(root, path), 'utf8') }));

/** The Prometheus exporter's name for an OTel metric: dots to underscores, the unit (`ms` → `milliseconds`), `_total` on a counter. */
function promName(metric: MetricData): string {
  const units: Record<string, string> = { ms: 'milliseconds', s: 'seconds', By: 'bytes', '1': '' };
  const unit = metric.descriptor.unit in units ? units[metric.descriptor.unit] : metric.descriptor.unit;
  const base = `${metric.descriptor.name.replace(/\./g, '_')}${unit ? `_${unit}` : ''}`;
  return metric.dataPointType === DataPointType.SUM && metric.isMonotonic ? `${base}_total` : base;
}

/** Emitted: Prometheus metric name → label name → the values seen. */
type Emitted = Map<string, Map<string, Set<string>>>;

/** The PromQL expressions of a file: every `expr` in the dashboard JSON, or every rule's `expr` in the rules YAML. */
function exprsOf(path: string, text: string): string[] {
  if (path.endsWith('.json')) {
    const out: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') for (const [key, inner] of Object.entries(value)) key === 'expr' && typeof inner === 'string' ? out.push(inner) : walk(inner);
    };
    walk(JSON.parse(text));
    return out;
  }
  const doc = parse(text) as { groups: Array<{ rules: Array<{ expr: string }> }> };
  return doc.groups.flatMap((g) => g.rules.map((r) => r.expr));
}

/** Every selector on a `landflow_ai_*` metric in one file: `name{a="x",b="y"}`, and the `by (...)` labels of its expression. */
function aiQueries(path: string, text: string): Array<{ metric: string; labels: Record<string, string>; by: string[] }> {
  const out: Array<{ metric: string; labels: Record<string, string>; by: string[] }> = [];
  for (const expr of exprsOf(path, text)) {
    const by = [...expr.matchAll(/by \(([^)]*)\)/g)].flatMap((m) => m[1]!.split(',').map((s) => s.trim()).filter(Boolean));
    // Label names after `by (` are not metrics.
    for (const m of expr.replace(/by \([^)]*\)/g, '').matchAll(/\b(landflow_ai_[A-Za-z0-9_]+)\b(\{([^}]*)\})?/g)) {
      const labels = Object.fromEntries([...(m[3] ?? '').matchAll(/([a-z_]+)\s*=~?\s*"([^"]*)"/g)].map((l) => [l[1]!, l[2]!]));
      out.push({ metric: m[1]!, labels, by });
    }
  }
  return out;
}

let emitted: Emitted;

beforeAll(async () => {
  // Priced, so the call also emits landflow.ai.cost (the cost-by-purpose panel).
  savePriceOverrides([{ provider: 'anthropic', model: 'claude-join', input: 1, output: 2 }]);
  aiUsageMeter().invalidatePrices();
  const model = anthropicModel({ model: 'claude-join', effort: 'low', maxTokens: 100, fallback: false, apiKey: 'sk-ant-test', baseUrl: fake.origin });
  await runInUsageScope(executionScope({ executionId: 'ex_metrics_join', workflowId: 'wf_metrics_join' }), () =>
    withCallPurpose('summary', () => model.generate({ messages: [{ role: 'user', content: 'hello' }], tools: [] })),
  );
  const { resourceMetrics } = await reader.collect();
  emitted = new Map();
  for (const metric of resourceMetrics.scopeMetrics.flatMap((s) => s.metrics)) {
    const name = promName(metric);
    const labels = emitted.get(name) ?? new Map<string, Set<string>>();
    for (const point of metric.dataPoints) {
      for (const [key, value] of Object.entries(point.attributes)) {
        const label = key.replace(/\./g, '_');
        labels.set(label, (labels.get(label) ?? new Set()).add(String(value)));
      }
    }
    emitted.set(name, labels);
  }
});

afterAll(async () => {
  await fake.close();
  metrics.disable();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

describe('spend-metrics-join: what SP04 queries is what SP01 emits', () => {
  it('a real call emits cache_read and cache_write tokens and the purpose label', () => {
    const tokens = emitted.get('landflow_ai_tokens_total');
    expect(tokens, [...emitted.keys()].join(', ')).toBeDefined();
    expect([...tokens!.get('gen_ai_token_type')!].sort()).toEqual(['cache_read', 'cache_write', 'input', 'output']);
    expect([...tokens!.get('landflow_ai_purpose')!]).toEqual(['summary']);
    expect([...tokens!.get('gen_ai_system')!]).toEqual(['anthropic']);
  });

  it('every AI metric, label and label value the dashboards and rules query was emitted', () => {
    // Both copies of each file are the same (exception-fingerprint.test.ts); each is checked here on its own anyway.
    let checked = 0;
    for (const { path, text } of sources) {
      const queries = aiQueries(path, text);
      expect(queries.length, path).toBeGreaterThan(0);
      for (const query of queries) {
        const where = `${path}: ${query.metric}`;
        const labels = emitted.get(query.metric);
        expect(labels, `${where} (emitted: ${[...emitted.keys()].filter((n) => n.startsWith('landflow_ai')).join(', ')})`).toBeDefined();
        for (const [label, value] of Object.entries(query.labels)) {
          expect(labels!.has(label), `${where} label ${label}`).toBe(true);
          expect(labels!.get(label)!.has(value), `${where} ${label}="${value}"`).toBe(true);
        }
        for (const label of query.by) expect(labels!.has(label), `${where} by (${label})`).toBe(true);
        checked++;
      }
    }
    // The AI row's three panels and the cache alert reference several AI series in each file.
    expect(checked).toBeGreaterThanOrEqual(12);
  });
});
