/**
 * Queue mode on a real Postgres (opt-in: LANDFLOW_INTEGRATION=queue): processes sharing the database follow each
 * other's writes (db/replication.ts). Uses LANDFLOW_TEST_DATABASE_URL, default the infra stack's `landflow_test`
 * database, in a schema of its own (`landflow_queue_test`, dropped and recreated): shared opens next to each other and
 * none next to a regular-mode host, small rows inline, big rows read back by key, deletes, the tables-changed
 * listeners, rows read fresh on demand, and two processes writing one row ending on the same value.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/server/db/database';
import type { TablesChanged } from '@/lib/server/db/replication';

const BASE_URL = process.env.LANDFLOW_TEST_DATABASE_URL ?? 'postgres://landflow:landflow-dev-only@127.0.0.1:55432/landflow_test';
const SCHEMA = 'landflow_queue_test';
const URL = `${BASE_URL}${BASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;
const enabled = Boolean(process.env.LANDFLOW_INTEGRATION?.split(',').includes('queue'));

vi.setConfig({ testTimeout: 30_000 });

describe.skipIf(!enabled)('queue mode on Postgres', async () => {
  const pg = (await import('pg')).default;
  const { openPostgres } = await import('@/lib/server/db/postgres');
  const { onTablesChanged, refreshRows } = await import('@/lib/server/db/replication');
  const admin = new pg.Pool({ connectionString: URL, max: 2 });
  const tmp = () => mkdtempSync(join(tmpdir(), 'landflow-pgq-'));
  const opened: Database[] = [];
  const until = (check: () => void) => vi.waitFor(check, { timeout: 10_000, interval: 25 });
  const workflowRow = (id: string, name: string, extra = '') => ({ id, name, active: 0, folder_id: null, created_at: null, updated_at: null, data: JSON.stringify({ id, name, nodes: [], connections: [], extra }) });
  const nameIn = (db: Database, id: string) => db.get<{ name: string }>('SELECT name FROM workflows WHERE id = ?', id)?.name;
  let main: Database;
  let worker: Database;

  beforeAll(async () => {
    if (!/_test$/.test(new globalThis.URL(BASE_URL).pathname)) throw new Error(`Refusing to use ${BASE_URL}: its database name must end in _test`);
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    main = await openPostgres(URL, tmp(), { instanceId: 'pgq-main' });
    opened.push(main);
    // The worker opens second: it loads what the main wrote, then follows.
    main.upsert('workflows', workflowRow('wf_before', 'Before the worker'));
    await main.flush();
    worker = await openPostgres(URL, tmp(), { instanceId: 'pgq-worker' });
    opened.push(worker);
  });

  afterAll(async () => {
    for (const db of opened) await db.close().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  it('opens next to the other processes, and refuses a regular-mode host while they run', async () => {
    expect(nameIn(worker, 'wf_before')).toBe('Before the worker');
    await expect(openPostgres(URL, tmp())).rejects.toThrow(/Another Landflow host is using this Postgres database/);
  });

  it('applies the other processes’ writes as they commit: small rows inline, big ones read back, deletes', async () => {
    const heard: TablesChanged[] = [];
    const unsubscribe = onTablesChanged((change) => heard.push(change));
    try {
      main.upsert('workflows', workflowRow('wf_small', 'Small'));
      main.upsert('workflows', workflowRow('wf_big', 'Big', 'x'.repeat(20_000)));
      await main.flush();
      await until(() => expect([nameIn(worker, 'wf_small'), nameIn(worker, 'wf_big')]).toEqual(['Small', 'Big']));
      expect(JSON.parse(worker.get<{ data: string }>('SELECT data FROM workflows WHERE id = ?', 'wf_big')!.data).extra).toHaveLength(20_000);
      expect(heard.some((change) => change.tables.has('workflows'))).toBe(true);

      worker.delete('workflows', { id: 'wf_small' });
      await worker.flush();
      await until(() => expect(nameIn(main, 'wf_small')).toBeUndefined());
    } finally {
      unsubscribe();
    }
  });

  it('reads a row fresh on demand', async () => {
    // Written behind the processes' backs (no notice): only a refresh sees it.
    await admin.query('INSERT INTO workflows (id, name, active, data) VALUES ($1, $2, 0, $3)', ['wf_direct', 'Direct', JSON.stringify({ id: 'wf_direct', name: 'Direct', nodes: [], connections: [] })]);
    expect(nameIn(worker, 'wf_direct')).toBeUndefined();
    // refreshRows reads into the process's registered copy (the last opened: the worker).
    await refreshRows('workflows', { id: 'wf_direct' });
    expect(nameIn(worker, 'wf_direct')).toBe('Direct');
  });

  it('ends every process on the last committed write when two write one row', async () => {
    main.upsert('workflows', workflowRow('wf_race', 'Main first'));
    await main.flush();
    await until(() => expect(nameIn(worker, 'wf_race')).toBe('Main first'));
    worker.upsert('workflows', workflowRow('wf_race', 'Worker second'));
    main.upsert('workflows', workflowRow('wf_race', 'Main third'));
    await Promise.all([main.flush(), worker.flush()]);
    // Both end on what Postgres holds: the last commit wins everywhere.
    const final = (await admin.query('SELECT name FROM workflows WHERE id = $1', ['wf_race'])).rows[0].name as string;
    await until(() => expect([nameIn(main, 'wf_race'), nameIn(worker, 'wf_race')]).toEqual([final, final]));
  });
});
