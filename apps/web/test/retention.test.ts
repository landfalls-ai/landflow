/**
 * Execution retention in SQL (settings.pruneExecutions) and off the save path (retentionTick): the same ids as
 * staleExecutionIds, finished runs only, and no listing of every summary when a run finishes.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionRecord } from '@/lib/shared/types';

const previousDir = process.env.LANDFLOW_DATA_DIR;
const previousEvery = process.env.LANDFLOW_RETENTION_EVERY;
process.env.LANDFLOW_DATA_DIR = mkdtempSync(join(tmpdir(), 'landflow-retention-'));

const { store } = await import('@/lib/server/store');
// The store only emits finished executions; retention subscribes through the reactions.
const { ensureExecutionReactions } = await import('@/lib/server/execution-reactions');
ensureExecutionReactions();
const { database } = await import('@/lib/server/db');
const { pruneExecutions, resetRetentionTick, retentionCounts, staleExecutionIds, updateSettings } = await import('@/lib/server/settings');

afterAll(() => {
  process.env.LANDFLOW_DATA_DIR = previousDir;
  if (previousEvery === undefined) delete process.env.LANDFLOW_RETENTION_EVERY;
  else process.env.LANDFLOW_RETENTION_EVERY = previousEvery;
});

const DAY = 86_400_000;

function execution(id: string, status: string, startedMs: number): ExecutionRecord {
  const started = new Date(startedMs).toISOString();
  return { executionId: id, workflowId: 'wf_ret', workflowName: 'Ret', mode: 'trigger', status: status as ExecutionRecord['status'], startedAt: started, finishedAt: started, durationMs: 1, runData: {}, executionOrder: [] };
}
const all = () => store.listExecutions({ limit: Infinity });

function clear() {
  for (const row of database().all<{ id: string }>('SELECT id FROM executions')) store.deleteExecution(row.id);
}

/** Insert without going through saveExecution (which would prune on the way). */
function seed(records: ExecutionRecord[]) {
  process.env.LANDFLOW_RETENTION_EVERY = '1000000';
  for (const r of records) store.saveExecution(r);
}

describe('pruneExecutions in SQL', () => {
  beforeEach(() => {
    clear();
    updateSettings({ executions: { maxCount: 300, maxAgeDays: 0 } });
  });

  it('keeps the newest 300 of 2,000 finished runs, and never running or waiting ones', () => {
    const base = Date.now() - 10_000_000;
    const records = Array.from({ length: 2000 }, (_, i) => execution(`ex_${String(i).padStart(4, '0')}`, 'success', base + i * 1000));
    records.push(execution('ex_wait', 'waiting', base - DAY), execution('ex_run', 'running', base - DAY));
    seed(records);
    expect(pruneExecutions({ maxCount: 300, maxAgeDays: 0 })).toBe(1700);
    const finished = all().filter((e) => e.status === 'success').map((e) => e.id);
    expect(finished).toHaveLength(300);
    expect(finished[0]).toBe('ex_1999');
    expect(finished.at(-1)).toBe('ex_1700');
    expect(store.getExecution('ex_wait')).toBeDefined();
    expect(store.getExecution('ex_run')).toBeDefined();
  });

  it('prunes by age', () => {
    const now = Date.now();
    seed([execution('old1', 'error', now - 9 * DAY), execution('old2', 'canceled', now - 8 * DAY), execution('new', 'success', now - DAY), execution('oldwait', 'waiting', now - 30 * DAY)]);
    expect(pruneExecutions({ maxCount: 0, maxAgeDays: 7 }, now)).toBe(2);
    expect(all().map((e) => e.id).sort()).toEqual(['new', 'oldwait']);
  });

  it('selects the same ids as staleExecutionIds', () => {
    const now = Date.now();
    const statuses = ['success', 'error', 'canceled', 'waiting', 'running', 'success'];
    const records = Array.from({ length: 60 }, (_, i) => execution(`eq_${String(i).padStart(2, '0')}`, statuses[i % statuses.length], now - i * 4 * 3_600_000));
    seed(records);
    const policy = { maxCount: 7, maxAgeDays: 4 };
    const expected = staleExecutionIds(all(), policy, now).sort();
    // Settings → General's counts agree with what the prune removes.
    expect(retentionCounts(policy, now)).toEqual({ stored: all().length, prunable: expected.length });
    const before = new Set(all().map((e) => e.id));
    pruneExecutions(policy, now);
    const after = new Set(all().map((e) => e.id));
    expect([...before].filter((id) => !after.has(id)).sort()).toEqual(expected);
  });
});

describe('retentionTick off the save path', () => {
  beforeEach(() => {
    clear();
    updateSettings({ executions: { maxCount: 10, maxAgeDays: 0 } });
  });

  it('100 saves at the default setting run exactly two prune passes (at 50 and 100) and never list all summaries', () => {
    delete process.env.LANDFLOW_RETENTION_EVERY;
    resetRetentionTick();
    const db = database();
    const spy = vi.spyOn(db, 'all');
    const base = Date.now() - 1_000_000;
    for (let i = 0; i < 100; i++) store.saveExecution(execution(`tick_${i}`, 'success', base + i * 1000));
    const sqls = spy.mock.calls.map((c) => String(c[0]));
    spy.mockRestore();
    const passes = sqls.filter((s) => /FROM executions WHERE status IN/.test(s) && /OFFSET/.test(s)).length;
    expect(passes).toBe(2);
    expect(sqls.some((s) => /SELECT summary/.test(s) && !/LIMIT/.test(s))).toBe(false);
    // The pass at save 100 left exactly the cap.
    expect(all().length).toBe(10);
  });

  it('treats LANDFLOW_RETENTION_EVERY=0 (or a fraction) as 1: every finished save prunes', () => {
    resetRetentionTick();
    for (const every of ['0', '0.5']) {
      process.env.LANDFLOW_RETENTION_EVERY = every;
      const base = Date.now() - 1_000_000;
      for (let i = 0; i < 15; i++) store.saveExecution(execution(`every_${every}_${i}`, 'success', base + i * 1000));
      expect(all().length).toBe(10);
    }
    delete process.env.LANDFLOW_RETENTION_EVERY;
  });
});
