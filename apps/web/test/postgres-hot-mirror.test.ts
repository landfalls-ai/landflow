/**
 * The hot mirror on a real Postgres (opt-in: LANDFLOW_INTEGRATION=postgres). Uses LANDFLOW_TEST_DATABASE_URL, default the
 * infra stack's `landflow_test` database, in a schema of its own (`landflow_hot_test`, dropped and recreated): boot with
 * 500 finished and 5 running executions loads data only for the hot ones, a cold run's record and journal are served
 * from Postgres (the route, the journal readers, a scan), deleting a cold run and the retention sweep reach its events in
 * Postgres, a cold run is loaded back before a decision is written to its journal, and eviction sends nothing.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { seedExecutions } from '../scripts/seed-executions';

const BASE_URL = process.env.LANDFLOW_TEST_DATABASE_URL ?? 'postgres://landflow:landflow-dev-only@127.0.0.1:55432/landflow_test';
const SCHEMA = 'landflow_hot_test';
const URL = `${BASE_URL}${BASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;
const enabled = Boolean(process.env.LANDFLOW_INTEGRATION?.split(',').includes('postgres'));

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe.skipIf(!enabled)('Postgres hot mirror', async () => {
  const pg = (await import('pg')).default;
  const admin = new pg.Pool({ connectionString: URL, max: 2 });
  const previous = { db: process.env.LANDFLOW_DB, url: process.env.DATABASE_URL, dir: process.env.LANDFLOW_DATA_DIR };
  const count = async (sql: string, ...values: unknown[]) => Number((await admin.query(sql, values)).rows[0].n);
  let db: import('@/lib/server/db/database').Database;
  let closeDatabase: () => Promise<void>;

  beforeAll(async () => {
    if (!/_test$/.test(new globalThis.URL(BASE_URL).pathname)) throw new Error(`Refusing to use ${BASE_URL}: its database name must end in _test`);
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    // The schema is migrated by a first boot, then seeded behind the host's back.
    const { openPostgres } = await import('@/lib/server/db/postgres');
    await (await openPostgres(URL, mkdtempSync(join(tmpdir(), 'landflow-hot-')))).close();
    await seedExecutions(admin, { count: 500, running: 5, events: 4, items: 3 });
    // One more cold run, newer than the rest, for the journal tests (retention keeps the newest).
    const finished = new Date(Date.now() - 2 * 24 * 3_600_000).toISOString();
    await admin.query(`INSERT INTO executions (id, workflow_id, status, mode, started_at, finished_at, duration_ms, summary, data) VALUES ('seed_keep', 'wf_seed', 'success', 'trigger', $1, $1, 1, '{}', '{"executionId":"seed_keep"}')`, [finished]);
    Object.assign(process.env, { LANDFLOW_DB: 'postgres', DATABASE_URL: URL, LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-hot-')) });
    const index = await import('@/lib/server/db');
    closeDatabase = index.closeDatabase;
    db = await index.openDatabase();
    // Retention (300 runs by default) would sweep the seeded runs behind the tests' backs: it has its own test below.
    (await import('@/lib/server/settings')).updateSettings({ executions: { maxCount: 100_000 } });
  });

  afterAll(async () => {
    await closeDatabase?.();
    for (const [key, value] of [['LANDFLOW_DB', previous.db], ['DATABASE_URL', previous.url], ['LANDFLOW_DATA_DIR', previous.dir]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  const local = (sql: string, ...params: Array<string | number>) => Number(db.get<{ n: number }>(sql, ...params)?.n);

  it('loads every row but the data and journal of cold runs at boot', () => {
    expect(local('SELECT COUNT(*) AS n FROM executions')).toBe(506);
    expect(local("SELECT COUNT(*) AS n FROM executions WHERE data <> ''")).toBe(5);
    expect(local('SELECT COUNT(*) AS n FROM execution_events')).toBe(5 * 4);
    // The summary columns of a cold run are all there for lists and filters.
    expect(db.get<{ status: string; finished_at: string }>("SELECT status, finished_at FROM executions WHERE id = 'seed_done_7'")).toMatchObject({ status: 'success' });
  });

  it('serves a cold run through GET /api/executions/:id with its full data', async () => {
    const { GET } = await import('@/app/api/executions/[id]/route');
    const response = await GET(new Request('http://localhost/api/executions/seed_done_7'), { params: Promise.resolve({ id: 'seed_done_7' }) });
    expect(response.status).toBe(200);
    const { execution } = (await response.json()) as { execution: { executionId: string; status: string; runData: Record<string, Array<{ outputs: unknown[][] }>> } };
    expect(execution.executionId).toBe('seed_done_7');
    expect(Object.keys(execution.runData)).toHaveLength(6);
    expect(execution.runData.node_0[0].outputs[0]).toHaveLength(3);
    // Reading it did not bring it back into the copy.
    expect(local("SELECT COUNT(*) AS n FROM executions WHERE id = 'seed_done_7' AND data <> ''")).toBe(0);
  });

  it('lists every column of executions in the mirror select (a later migration cannot load as NULL)', async () => {
    const { mirrorSelect } = await import('@/lib/server/db/hot-mirror');
    const columns = (await admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'executions'", [SCHEMA])).rows.map((row) => String(row.column_name));
    const selected = [...mirrorSelect('executions', new Date().toISOString()).text.matchAll(/\be\.(\w+)/g)].map((m) => m[1]);
    for (const column of columns) expect(selected, column).toContain(column);
  });

  it('answers for a finished cold run the way it does for a hot one: stop 409, form finished page, approval 409, duplicate status', async () => {
    const id = 'seed_done_11';
    expect(local(`SELECT COUNT(*) AS n FROM executions WHERE id = '${id}' AND data <> ''`)).toBe(0);
    const { POST: stop } = await import('@/app/api/executions/[id]/stop/route');
    const stopped = await stop(new Request(`http://localhost/api/executions/${id}/stop`, { method: 'POST' }), { params: Promise.resolve({ id }) });
    expect(stopped.status).toBe(409);
    expect(await stopped.json()).toMatchObject({ executionId: id, status: 'success' });
    const { GET: form } = await import('@/app/form/waiting/[id]/route');
    const page = await form(new Request(`http://localhost/form/waiting/${id}`), { params: Promise.resolve({ id }) });
    expect(page.status).not.toBe(404);
    const { decideApproval } = await import('@/lib/server/approvals');
    await expect(decideApproval(id, 'call_1', true)).rejects.toMatchObject({ status: 409 });
    const { store } = await import('@/lib/server/store');
    expect((await store.loadExecution(id))?.status).toBe('success');
  });

  it('serves the journal of a cold run and scans across cold and hot runs', async () => {
    const journal = await import('@/lib/server/journal/store');
    const events = await journal.readAllAsync('seed_done_8');
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(await journal.lastSeqAsync('seed_done_8')).toBe(4);
    expect((await journal.readEventsAsync('seed_done_8', 2, 10)).map((event) => event.seq)).toEqual([3, 4]);
    const { readRows } = await import('@/lib/server/db/reads');
    const rows = await readRows<{ id: string }>("SELECT id FROM executions WHERE data LIKE ? AND status <> 'running' ORDER BY id LIMIT ?", '%"workflowName":"Seeded workflow"%', 1000);
    expect(rows).toHaveLength(500);
    const running = await readRows<{ n: number }>("SELECT COUNT(*) AS n FROM execution_events e WHERE e.execution_id LIKE 'seed_running_%' AND e.type = ?", 'span.ended');
    expect(Number(running[0].n)).toBe(20);
  });

  it('replays a delete of a cold run on Postgres, events included', async () => {
    const { store } = await import('@/lib/server/store');
    expect(await count("SELECT COUNT(*) AS n FROM execution_events WHERE execution_id = 'seed_done_9'")).toBe(4);
    expect(store.deleteExecution('seed_done_9')).toBe(true);
    await db.flush();
    expect(await count("SELECT COUNT(*) AS n FROM execution_events WHERE execution_id = 'seed_done_9'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM executions WHERE id = 'seed_done_9'")).toBe(0);
  });

  it('replays the retention sweeps on Postgres: by count (rows and journals) and by age (journals)', async () => {
    const { pruneExecutions } = await import('@/lib/server/settings');
    const journal = await import('@/lib/server/journal/store');
    expect(await count("SELECT COUNT(*) AS n FROM executions WHERE id LIKE 'seed_done_%'")).toBe(499);
    expect(pruneExecutions({ maxCount: 450, maxAgeDays: 0 })).toBe(50);
    await db.flush();
    expect(await count("SELECT COUNT(*) AS n FROM executions WHERE id LIKE 'seed_done_%'")).toBe(449);
    // Nothing is left of the deleted runs' journals: 449 runs of 4 events remain.
    expect(await count("SELECT COUNT(*) AS n FROM execution_events WHERE execution_id LIKE 'seed_done_%'")).toBe(449 * 4);
    // The journal's own age limit: the cold runs finished two days ago, the running ones' events are a minute old.
    expect(journal.prune(new Date(Date.now() - 24 * 3_600_000).toISOString())).toBe(0);
    await db.flush();
    expect(await count("SELECT COUNT(*) AS n FROM execution_events WHERE execution_id LIKE 'seed_done_%'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM execution_events WHERE execution_id LIKE 'seed_running_%'")).toBe(20);
  });

  it('loads a cold run back before a decision is written to its journal', async () => {
    const { promoteExecution } = await import('@/lib/server/db/reads');
    const journal = await import('@/lib/server/journal/store');
    // seed_keep's events were pruned above: put two back in Postgres, as if a journal were kept.
    await admin.query(`INSERT INTO execution_events (execution_id, seq, at, type, span_id, data) VALUES ('seed_keep', 1, $1, 'check', 'span', '{"seq":1}'), ('seed_keep', 2, $1, 'check', 'span', '{"seq":2}')`, [new Date().toISOString()]);
    expect(journal.lastSeq('seed_keep')).toBe(1);
    expect(() => journal.append('seed_keep', [])).toThrow(/promoteExecution/);
    await promoteExecution('seed_keep');
    expect(journal.lastSeq('seed_keep')).toBe(2);
    journal.append('seed_keep', [{ seq: 3, executionId: 'seed_keep', at: new Date().toISOString(), type: 'check', spanId: 'span' } as never]);
    await db.flush();
    expect(await count("SELECT COUNT(*) AS n FROM execution_events WHERE execution_id = 'seed_keep'")).toBe(3);
  });

  it('evicts runs that cool down without writing to Postgres, and reads them back', async () => {
    const { store } = await import('@/lib/server/store');
    const { evictCold } = await import('@/lib/server/db/hot-mirror');
    const { readExecutionData } = await import('@/lib/server/db/reads');
    const now = new Date().toISOString();
    store.saveExecution({ executionId: 'ex_hot_now', workflowId: 'wf', workflowName: 'W', mode: 'manual', status: 'success', startedAt: now, finishedAt: now, durationMs: 1, runData: {}, executionOrder: [] });
    await db.flush();
    expect(local("SELECT COUNT(*) AS n FROM executions WHERE id = 'ex_hot_now' AND data <> ''")).toBe(1);
    const before = await count('SELECT COUNT(*) AS n FROM executions');
    // An hour from now it is cold; the promoted seed_keep stays.
    expect(evictCold(db, Date.now() + 3_600_000 + 60_000)).toBeGreaterThanOrEqual(1);
    expect(local("SELECT COUNT(*) AS n FROM executions WHERE id = 'ex_hot_now' AND data <> ''")).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM executions')).toBe(before);
    expect(JSON.parse((await readExecutionData('ex_hot_now')) ?? '{}').executionId).toBe('ex_hot_now');
    expect(await count("SELECT COUNT(*) AS n FROM executions WHERE id = 'ex_hot_now' AND data = ''")).toBe(0);
  });
});

describe.skipIf(!enabled)('Postgres hot mirror in queue mode', async () => {
  const pg = (await import('pg')).default;
  const queueSchema = 'landflow_hot_queue_test';
  const queueUrl = `${BASE_URL}${BASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${queueSchema}`)}`;
  const admin = new pg.Pool({ connectionString: queueUrl, max: 2 });
  const opened: Array<{ close(): Promise<void> }> = [];
  const dir = () => mkdtempSync(join(tmpdir(), 'landflow-hot-q-'));
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const row = (id: string, status: string, finishedMinutesAgo: number) => ({ id, workflow_id: 'wf', status, mode: 'manual', started_at: minutesAgo(finishedMinutesAgo + 1), finished_at: minutesAgo(finishedMinutesAgo), duration_ms: 1, summary: '{}', data: JSON.stringify({ executionId: id, status }) });
  let main: import('@/lib/server/db/database').Database;
  let worker: import('@/lib/server/db/database').Database;

  beforeAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${queueSchema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${queueSchema}`);
    const { openPostgres } = await import('@/lib/server/db/postgres');
    main = await openPostgres(queueUrl, dir(), { instanceId: 'hot-main' });
    opened.push(main);
    worker = await openPostgres(queueUrl, dir(), { instanceId: 'hot-worker' });
    opened.push(worker);
  });

  afterAll(async () => {
    for (const db of opened) await db.close().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${queueSchema} CASCADE`);
    await admin.end();
  });

  const dataIn = (db: import('@/lib/server/db/database').Database, id: string) => db.get<{ data: string }>('SELECT data FROM executions WHERE id = ?', id)?.data;

  it('keeps data and journal only of hot runs when another process writes them', async () => {
    main.upsert('executions', row('q_fresh', 'success', 1));
    main.upsert('executions', row('q_old', 'success', 300));
    main.upsert('execution_events', { execution_id: 'q_old', seq: 1, at: minutesAgo(300), type: 'check', span_id: 's', data: '{}' });
    main.upsert('execution_events', { execution_id: 'q_fresh', seq: 1, at: minutesAgo(1), type: 'check', span_id: 's', data: '{}' });
    await main.flush();
    await vi.waitFor(() => expect(worker.get('SELECT id FROM executions WHERE id = ?', 'q_old')).toBeDefined(), { timeout: 10_000, interval: 25 });
    await vi.waitFor(() => expect(worker.get('SELECT 1 AS x FROM execution_events WHERE execution_id = ?', 'q_fresh')).toBeDefined(), { timeout: 10_000, interval: 25 });
    expect(dataIn(worker, 'q_fresh')).toContain('q_fresh');
    expect(dataIn(worker, 'q_old')).toBe('');
    expect(worker.get('SELECT 1 AS x FROM execution_events WHERE execution_id = ?', 'q_old')).toBeUndefined();
    // The writer keeps its own rows until its evictor sweeps them.
    expect(dataIn(main, 'q_old')).toContain('q_old');
  });

  it('a process that boots later loads only the hot data too', async () => {
    const { openPostgres } = await import('@/lib/server/db/postgres');
    const late = await openPostgres(queueUrl, dir(), { instanceId: 'hot-late' });
    opened.push(late);
    expect(dataIn(late, 'q_fresh')).toContain('q_fresh');
    expect(dataIn(late, 'q_old')).toBe('');
  });
});
