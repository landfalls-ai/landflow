/**
 * Several mains share the evaluation tables: a run that is `running` but not in this process's memory belongs to another
 * main (viewing the Evaluations tab calls `settleInterrupted`). It must be left alone while that main's heartbeat is fresh,
 * and settled as interrupted once the heartbeat has stopped (the process died). Before the heartbeat (migration 1880) every
 * run not in this process's memory was failed on sight, so opening the tab on main B killed main A's evaluation.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { EvaluationRunSummary } from '@/shared/evaluations';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-eval-mains-'));
const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});

const evalStore = await import('@/lib/server/evaluations/store');
const { settleInterrupted, STALE_MS } = await import('@/lib/server/evaluations/runner');

const run = (id: string): EvaluationRunSummary => ({
  id,
  workflowId: 'wf_x',
  workflowName: 'X',
  number: 1,
  status: 'running',
  startedAt: new Date(Date.now() - 3_600_000).toISOString(),
  dataTableId: 'dt',
  dataTableName: 'dt',
  total: 3,
  completed: 1,
  failed: 0,
  metrics: {},
});

describe('evaluation runs on several mains', () => {
  it('leaves a run another main is working on, settles one whose process stopped', () => {
    // Saved just now by "another main": its heartbeat is fresh, though its start was an hour ago.
    evalStore.saveRun(run('ev_other_main'));
    expect(settleInterrupted()).toBe(0);
    expect(evalStore.getRun('ev_other_main')?.status).toBe('running');
    // The other main keeps beating.
    evalStore.touchRun('ev_other_main');
    expect(settleInterrupted(Date.now() + STALE_MS - 1_000)).toBe(0);
    // It died: nobody beats, and a main that looks later settles the run.
    expect(settleInterrupted(Date.now() + STALE_MS + 5_000)).toBe(1);
    const settled = evalStore.getRun('ev_other_main');
    expect(settled?.status).toBe('error');
    expect(settled?.error).toMatch(/restarted/);
  });
});
