/**
 * Insights: the rollup (status, production vs manual, time-zone days, dedupe),
 * the report (KPIs vs the previous period, series, per-workflow rows, time
 * saved), the one-time backfill, and that figures survive execution pruning.
 * The first test boots the host on a data directory that already holds
 * executions: bootstrap must backfill the rollup and then prune.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutionRecord } from '@/lib/shared/types';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function record(id: string, overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    executionId: id,
    workflowId: 'wf_boot',
    workflowName: 'Boot flow',
    mode: 'trigger',
    status: 'success',
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 100,
    runData: {},
    executionOrder: [],
    ...overrides,
  };
}

// A data directory with five executions (one failed, one manual) and retention set to keep three, before anything loads.
const dataDir = mkdtempSync(join(tmpdir(), 'landflow-insights-'));
mkdirSync(join(dataDir, 'executions'), { recursive: true });
const seeded = [
  record('ex_boot_1', { startedAt: new Date(Date.now() - 5 * HOUR).toISOString() }),
  record('ex_boot_2', { startedAt: new Date(Date.now() - 4 * HOUR).toISOString(), status: 'error' }),
  record('ex_boot_3', { startedAt: new Date(Date.now() - 3 * HOUR).toISOString(), mode: 'manual' }),
  record('ex_boot_4', { startedAt: new Date(Date.now() - 2 * HOUR).toISOString() }),
  record('ex_boot_5', { startedAt: new Date(Date.now() - 1 * HOUR).toISOString() }),
];
for (const execution of seeded) writeFileSync(join(dataDir, 'executions', `${execution.executionId}.json`), JSON.stringify(execution));
writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ timezone: 'UTC', executions: { maxCount: 3, maxAgeDays: 0 } }));

const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { ensureBootstrapped } = await import('@/lib/server/bootstrap');
const { store } = await import('@/lib/server/store');
const { InsightsRollup, dayKey, insightsReport, insightsRollup } = await import('@/lib/server/insights');
const { updateSettings } = await import('@/lib/server/settings');
const { startDataMaintenance } = await import('@/lib/server/maintenance');

afterAll(() => {
  for (const key of ['LANDFLOW_DATA_DIR', 'LANDFLOW_REGISTRY_GRPC_PORT', 'LANDFLOW_SCAN_ON_START', 'LANDFLOW_PLUGINS']) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

describe('boot', () => {
  it('backfills the rollup from the executions on disk, then prunes them by the retention settings', async () => {
    await ensureBootstrapped();
    // Retention kept the newest three finished runs…
    expect(store.listExecutions({ limit: Infinity }).map((e) => e.id)).toEqual(['ex_boot_5', 'ex_boot_4', 'ex_boot_3']);
    // The JSON files were imported into the database once; their directory was renamed, every file kept.
    const imported = readdirSync(dataDir).find((name) => name.startsWith('executions.imported-'));
    expect(existsSync(join(dataDir, 'executions'))).toBe(false);
    expect(readdirSync(join(dataDir, imported!)).filter((f) => f.startsWith('ex_boot_')).sort()).toEqual(['ex_boot_1.json', 'ex_boot_2.json', 'ex_boot_3.json', 'ex_boot_4.json', 'ex_boot_5.json']);
    // …but the rollup was filled first, so all five count.
    const report = insightsReport('24h', true);
    expect(report.current).toMatchObject({ runs: 5, succeeded: 4, failed: 1 });
    expect(insightsReport('24h').current).toMatchObject({ runs: 4, failed: 1 });
    expect(report.backfilledAt).toBeTruthy();
    const saved = JSON.parse(readFileSync(join(dataDir, 'insights.json'), 'utf8'));
    expect(saved.backfilledAt).toBe(report.backfilledAt);
  });

  it('backfills once: a second boot (or maintenance run) adds nothing', () => {
    expect(insightsRollup().backfill(store.listExecutions({ limit: Infinity }))).toBe(0);
    expect(startDataMaintenance()).toEqual({ backfilled: 5, pruned: 2 });
    const reloaded = new InsightsRollup(join(dataDir, 'insights.json'), () => 'UTC');
    expect(reloaded.backfill(store.listExecutions({ limit: Infinity }))).toBe(0);
    expect(reloaded.report({ period: '24h', includeManual: true }).current.runs).toBe(5);
  });
});

describe('rollup', () => {
  const NOW = Date.parse('2026-10-25T12:30:00Z');
  const rollup = (timezone = 'UTC') => new InsightsRollup(join(mkdtempSync(join(tmpdir(), 'landflow-rollup-')), 'insights.json'), () => timezone);
  let n = 0;
  const run = (overrides: Partial<{ workflowId: string; workflowName: string; mode: string; status: string; startedAt: number; durationMs: number }> = {}) => ({
    id: `ex_${++n}`,
    workflowId: overrides.workflowId ?? 'wf_a',
    workflowName: overrides.workflowName ?? 'Flow A',
    mode: (overrides.mode ?? 'trigger') as never,
    status: (overrides.status ?? 'success') as never,
    startedAt: new Date(overrides.startedAt ?? NOW - HOUR).toISOString(),
    durationMs: overrides.durationMs ?? 1000,
  });

  it('counts finished runs by status and ignores running, waiting and repeated ones', () => {
    const r = rollup();
    const first = run({ status: 'success', durationMs: 1000 });
    expect(r.record(first, NOW)).toBe(true);
    expect(r.record(first, NOW)).toBe(false);
    r.record(run({ status: 'error', durationMs: 3000 }), NOW);
    r.record(run({ status: 'canceled', durationMs: 2000 }), NOW);
    expect(r.record(run({ status: 'running' }), NOW)).toBe(false);
    expect(r.record(run({ status: 'waiting' }), NOW)).toBe(false);
    expect(r.report({ period: '24h', now: NOW }).current).toEqual({
      runs: 3,
      succeeded: 1,
      failed: 1,
      canceled: 1,
      failureRate: 1 / 3,
      avgDurationMs: 2000,
      timeSavedMinutes: 0,
    });
  });

  it('leaves manual runs out unless asked', () => {
    const r = rollup();
    r.record(run(), NOW);
    r.record(run({ mode: 'manual', status: 'error' }), NOW);
    r.record(run({ mode: 'chat' }), NOW);
    r.record(run({ mode: 'webhook' }), NOW);
    expect(r.report({ period: '24h', now: NOW }).current).toMatchObject({ runs: 2, failed: 0 });
    expect(r.report({ period: '24h', now: NOW, includeManual: true }).current).toMatchObject({ runs: 4, failed: 1 });
  });

  it('compares with the previous period', () => {
    const r = rollup();
    // Last 24 h: 3 runs (1 failed); the 24 h before: 1 run.
    r.record(run({ startedAt: NOW - 2 * HOUR }), NOW);
    r.record(run({ startedAt: NOW - 20 * HOUR, status: 'error' }), NOW);
    r.record(run({ startedAt: NOW - 23 * HOUR }), NOW);
    r.record(run({ startedAt: NOW - 30 * HOUR }), NOW);
    // 7 days: 2 more runs 3 and 5 days ago, and 3 in the week before.
    r.record(run({ startedAt: NOW - 3 * DAY }), NOW);
    r.record(run({ startedAt: NOW - 5 * DAY, status: 'error' }), NOW);
    for (const days of [8, 9, 12]) r.record(run({ startedAt: NOW - days * DAY }), NOW);
    // Outside both 7-day windows, inside the 30-day one.
    r.record(run({ startedAt: NOW - 20 * DAY }), NOW);

    const day = r.report({ period: '24h', now: NOW });
    expect(day.current).toMatchObject({ runs: 3, failed: 1 });
    expect(day.previous).toMatchObject({ runs: 1, failed: 0 });
    expect(day.series).toHaveLength(24);
    expect(day.series.at(-1)).toMatchObject({ key: '2026-10-25T12', label: '12:00' });
    expect(day.series.reduce((sum, b) => sum + b.succeeded + b.failed, 0)).toBe(3);

    const week = r.report({ period: '7d', now: NOW });
    expect(week.current).toMatchObject({ runs: 6, failed: 2 });
    expect(week.previous).toMatchObject({ runs: 3 });
    expect(week.series.map((b) => b.key)).toEqual(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
    expect(week.series.at(-1)?.label).toBe('Oct 25');

    const month = r.report({ period: '30d', now: NOW });
    expect(month.series).toHaveLength(30);
    expect(month.current.runs).toBe(10);
  });

  it('buckets days in the instance time zone', () => {
    const late = Date.parse('2026-10-25T23:30:00Z');
    expect(dayKey(late, 'America/New_York')).toBe('2026-10-25');
    expect(dayKey(late, 'Asia/Tokyo')).toBe('2026-10-26');
    const tokyo = rollup('Asia/Tokyo');
    tokyo.record(run({ startedAt: late }), late + HOUR);
    expect(tokyo.report({ period: '7d', now: late + HOUR }).series.at(-1)).toMatchObject({ key: '2026-10-26', succeeded: 1 });
  });

  it('reports per workflow, with time saved from each workflow’s minutes per run', () => {
    const r = rollup();
    for (let i = 0; i < 4; i++) r.record(run({ workflowId: 'wf_a', durationMs: 2000 }), NOW);
    r.record(run({ workflowId: 'wf_a', status: 'error', durationMs: 4000 }), NOW);
    r.record(run({ workflowId: 'wf_b', workflowName: 'Old name' }), NOW);
    r.record(run({ workflowId: 'wf_gone', workflowName: 'Deleted flow' }), NOW);
    const report = r.report({
      period: '7d',
      now: NOW,
      workflows: [
        { id: 'wf_a', name: 'Flow A', settings: { timeSavedMinutes: 5 } },
        { id: 'wf_b', name: 'Flow B' },
      ],
    });
    expect(report.workflows).toEqual([
      { workflowId: 'wf_a', name: 'Flow A', exists: true, minutesSavedPerRun: 5, runs: 5, succeeded: 4, failed: 1, canceled: 0, failureRate: 0.2, avgDurationMs: 2400, timeSavedMinutes: 20 },
      // Ties by name; a deleted workflow keeps the last name it ran under.
      { workflowId: 'wf_gone', name: 'Deleted flow', exists: false, runs: 1, succeeded: 1, failed: 0, canceled: 0, failureRate: 0, avgDurationMs: 1000, timeSavedMinutes: 0 },
      { workflowId: 'wf_b', name: 'Flow B', exists: true, runs: 1, succeeded: 1, failed: 0, canceled: 0, failureRate: 0, avgDurationMs: 1000, timeSavedMinutes: 0 },
    ]);
    expect(report.current.timeSavedMinutes).toBe(20);
  });

  it('persists and reloads', () => {
    const r = rollup();
    r.record(run(), NOW);
    r.record(run({ status: 'error' }), NOW);
    r.flush();
    const reloaded = new InsightsRollup(r.path, () => 'UTC');
    expect(reloaded.report({ period: '24h', now: NOW }).current).toMatchObject({ runs: 2, failed: 1 });
    expect(existsSync(r.path)).toBe(true);
  });
});

describe('with the store', () => {
  // Retention runs on every finished save here, so the cap below applies at once.
  const previousEvery = process.env.LANDFLOW_RETENTION_EVERY;
  beforeAll(() => {
    process.env.LANDFLOW_RETENTION_EVERY = '1';
  });
  afterAll(() => {
    if (previousEvery === undefined) delete process.env.LANDFLOW_RETENTION_EVERY;
    else process.env.LANDFLOW_RETENTION_EVERY = previousEvery;
  });

  it('counts every saved execution and keeps the figures after retention prunes them', () => {
    updateSettings({ executions: { maxCount: 2 } });
    const before = insightsReport('24h').current;
    for (let i = 1; i <= 6; i++) store.saveExecution(record(`ex_store_${i}`, { workflowId: 'wf_store', workflowName: 'Store flow', status: i === 6 ? 'error' : 'success' }));
    expect(store.listExecutions({ limit: Infinity })).toHaveLength(2);
    const after = insightsReport('24h');
    expect(after.current.runs - before.runs).toBe(6);
    expect(after.current.failed - before.failed).toBe(1);
    expect(after.workflows.find((w) => w.workflowId === 'wf_store')).toMatchObject({ name: 'Store flow', runs: 6, failed: 1, exists: false });
    // Saving the same finished execution again doesn't count it twice.
    store.saveExecution(record('ex_store_6', { workflowId: 'wf_store', status: 'error' }));
    expect(insightsReport('24h').workflows.find((w) => w.workflowId === 'wf_store')?.runs).toBe(6);
  });
});
