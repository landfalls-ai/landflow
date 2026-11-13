/**
 * The async read seam for run data (lib/server/db/reads.ts): loadExecution and the async journal readers return what the
 * synchronous ones do, and a source scan keeps `store.getExecution(` (runs in flight only) out of code that may read a
 * finished run.
 */
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-reads-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { journalOf, releaseJournal, resetJournals, journalStore } = await import('@/lib/server/journal');
const { store } = await import('@/lib/server/store');

afterAll(() => {
  resetJournals();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const record = (executionId: string, status: 'running' | 'success') => ({ executionId, workflowId: 'wf_reads', workflowName: 'Reads', mode: 'manual' as const, status, startedAt: new Date().toISOString(), durationMs: 10, runData: {}, executionOrder: [] });

describe('loadExecution', () => {
  it('equals getExecution for running and finished records, and for a missing or malformed id', async () => {
    store.saveExecution(record('rd_running', 'running'));
    store.saveExecution(record('rd_done', 'success'));
    for (const id of ['rd_running', 'rd_done', 'rd_missing', '../etc/passwd']) expect(await store.loadExecution(id)).toEqual(store.getExecution(id));
    expect((await store.loadExecution('rd_done'))?.status).toBe('success');
  });

  it('executionsMentioningAsync equals executionsMentioning', async () => {
    store.saveExecution({ ...record('rd_team', 'success'), runData: { n: [{ status: 'success', source: 'main', startedAt: '', durationMs: 1, inputs: [], outputs: [], note: '"teamId":"tm_x"' } as never] } });
    expect((await store.executionsMentioningAsync('rd_team')).map((r) => r.executionId)).toEqual(store.executionsMentioning('rd_team').map((r) => r.executionId));
    expect(await store.executionsMentioningAsync('tm_x', 3)).toEqual(store.executionsMentioning('tm_x', 3));
  });
});

describe('the async journal readers', () => {
  it('equal the synchronous ones', async () => {
    store.saveExecution(record('rd_journal', 'success'));
    const journal = journalOf('rd_journal', { workflowId: 'wf_reads' });
    const actor = { id: 'workflow', name: 'Reads', type: 'system' as const };
    journal.record({ type: 'span.started', spanId: 'run', kind: 'run', name: 'Reads', actor });
    journal.record({ type: 'span.started', spanId: 'run/a', parentSpanId: 'run', kind: 'step', name: 'A', actor });
    journal.record({ type: 'span.ended', spanId: 'run/a', status: 'success' });
    journal.record({ type: 'check', spanId: 'run', check: { name: 'c', status: 'fail', source: 'node' } });
    journal.record({ type: 'span.ended', spanId: 'run', status: 'success' });
    releaseJournal('rd_journal');

    expect(await journalStore.readEventsAsync('rd_journal', 1, 3)).toEqual(journalStore.read('rd_journal', 1, 3));
    expect(await journalStore.readAllAsync('rd_journal')).toEqual(journalStore.readAll('rd_journal'));
    expect((await journalStore.readAllAsync('rd_journal')).length).toBeGreaterThan(3);
    expect(await journalStore.lastSeqAsync('rd_journal')).toBe(journalStore.lastSeq('rd_journal'));
    expect(await journalStore.spanEventsAsync('rd_journal')).toEqual(journalStore.spanEvents('rd_journal'));
    expect(await journalStore.spanStartAsync('rd_journal', 'run/a')).toEqual(journalStore.spanStart('rd_journal', 'run/a'));
    expect(await journalStore.checksSinceAsync('2000-01-01T00:00:00.000Z')).toEqual(journalStore.checksSince('2000-01-01T00:00:00.000Z'));
    expect(await journalStore.readEventsAsync('rd_none')).toEqual([]);
  });
});

describe('the sync getExecution guard', () => {
  /** Files that handle runs in flight (running, waiting, queued) or resume them, and may read the synchronous way. */
  const ALLOWED = [
    'lib/server/store.ts',
    'lib/server/runner.ts',
    'lib/server/cluster/',
    'lib/server/sub-executions.ts',
    'lib/server/waits.ts',
    // Resume routes (the form-test redirect, the waiting-run lookup, the webhook replay): a waiting run is answered or started.
    'app/form-test/',
    'app/api/waiting/',
    'app/api/webhook/',
    // validateWorkflow is synchronous for its callers; see the comment at lastRunFields.
    'lib/server/mcp/workflows.ts',
  ];
  const root = join(__dirname, '..', 'src');
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : /\.tsx?$/.test(name) ? [join(dir, name)] : []));

  it('is called only from the allow-listed files; everything else uses store.loadExecution', () => {
    const offenders = walk(root)
      .map((file) => relative(root, file).split(sep).join('/'))
      .filter((file) => !ALLOWED.some((allowed) => file === allowed || (allowed.endsWith('/') && file.startsWith(allowed))))
      .filter((file) => readFileSync(join(root, file), 'utf8').includes('store.getExecution('));
    expect(offenders).toEqual([]);
  });
});

describe('backfillUsage', () => {
  it('resolves with 0 when a read fails, instead of rejecting', async () => {
    const { backfillUsage } = await import('@/lib/server/usage/backfill');
    const broken = { get: () => { throw new Error('read failed'); }, all: () => { throw new Error('read failed'); }, upsert: () => undefined } as never;
    await expect(backfillUsage(broken, true)).resolves.toBe(0);
  });
});
