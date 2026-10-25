/**
 * Postgres mode against a real database (opt-in: LANDFLOW_INTEGRATION=postgres). Uses
 * LANDFLOW_TEST_DATABASE_URL, default the infra stack's `landflow_test` database, in a schema of its
 * own (`landflow_runtime_test`, dropped and recreated; the pgvector tests use `public`): migrations,
 * the instance lock, writes replayed on Postgres in order, the in-memory copy loaded at boot, the
 * spool replayed after a crash, and the store on it.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Workflow } from '@landflow/engine';

const BASE_URL = process.env.LANDFLOW_TEST_DATABASE_URL ?? 'postgres://landflow:landflow-dev-only@127.0.0.1:55432/landflow_test';
const SCHEMA = 'landflow_runtime_test';
const URL = `${BASE_URL}${BASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;
const enabled = Boolean(process.env.LANDFLOW_INTEGRATION?.split(',').includes('postgres'));

describe.skipIf(!enabled)('Postgres mode', async () => {
  const pg = (await import('pg')).default;
  const { openPostgres, migratePostgres } = await import('@/lib/server/db/postgres');
  const { LATEST_VERSION } = await import('@/lib/server/db/schema');
  const admin = new pg.Pool({ connectionString: URL, max: 2 });
  const tmp = () => mkdtempSync(join(tmpdir(), 'landflow-pg-'));

  beforeAll(async () => {
    // Only ever a throwaway database.
    if (!/_test$/.test(new globalThis.URL(BASE_URL).pathname)) throw new Error(`Refusing to use ${BASE_URL}: its database name must end in _test`);
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  });

  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  const workflowRow = (id: string, name: string) => ({ id, name, active: 0, folder_id: null, created_at: null, updated_at: null, data: JSON.stringify({ id, name, nodes: [], connections: [] }) });

  it('migrates once, records the schema version and refuses a second host', async () => {
    const dir = tmp();
    const db = await openPostgres(URL, dir);
    try {
      expect(Number((await admin.query('SELECT MAX(version) AS v FROM schema_version')).rows[0].v)).toBe(LATEST_VERSION);
      expect(await migratePostgres(admin)).toEqual([]);
      await expect(openPostgres(URL, tmp())).rejects.toThrow(/Another Landflow host is using this Postgres database/);
    } finally {
      await db.close();
    }
  });

  it('serves reads from its copy, replays writes on Postgres in order and loads them at the next boot', async () => {
    const dir = tmp();
    const db = await openPostgres(URL, dir);
    db.upsert('workflows', workflowRow('wf_pg', 'First'));
    db.transaction(() => {
      db.upsert('workflows', workflowRow('wf_pg', 'Second'));
      db.upsert('workflows', workflowRow('wf_pg_2', 'Other'));
    });
    db.delete('workflows', { id: 'wf_pg_2' });
    expect(db.get<{ name: string }>('SELECT name FROM workflows WHERE id = ?', 'wf_pg')?.name).toBe('Second');
    await db.flush();
    expect((await admin.query('SELECT id, name FROM workflows ORDER BY id')).rows).toEqual([{ id: 'wf_pg', name: 'Second' }]);
    await db.close();

    const reopened = await openPostgres(URL, dir);
    try {
      expect(reopened.all<{ id: string; name: string }>('SELECT id, name FROM workflows ORDER BY id')).toEqual([{ id: 'wf_pg', name: 'Second' }]);
    } finally {
      await reopened.close();
    }
  });

  it('replays the spool after a crash: writes that never reached Postgres are not lost', async () => {
    const dir = tmp();
    const seq = Number((await admin.query("SELECT value FROM meta WHERE key = 'postgres.replica_seq'")).rows[0]?.value ?? 0);
    // What a host that died right after committing locally leaves behind: a batch Postgres never got (and a torn last line).
    const batch = { seq: seq + 1, ops: [{ op: 'upsert', table: 'workflows', row: workflowRow('wf_pg_spooled', 'From the spool') }] };
    writeFileSync(join(dir, 'postgres-queue.jsonl'), `${JSON.stringify(batch)}\n{"seq":${seq + 2},"ops":[{"op":"ups`);
    const db = await openPostgres(URL, dir);
    try {
      expect(db.get<{ name: string }>('SELECT name FROM workflows WHERE id = ?', 'wf_pg_spooled')?.name).toBe('From the spool');
      expect((await admin.query('SELECT name FROM workflows WHERE id = $1', ['wf_pg_spooled'])).rows[0]?.name).toBe('From the spool');
    } finally {
      await db.close();
    }
  });

  it('runs the store on Postgres (LANDFLOW_DB=postgres)', async () => {
    const previous = { db: process.env.LANDFLOW_DB, url: process.env.DATABASE_URL, dir: process.env.LANDFLOW_DATA_DIR };
    Object.assign(process.env, { LANDFLOW_DB: 'postgres', DATABASE_URL: URL, LANDFLOW_DATA_DIR: tmp() });
    const { openDatabase, closeDatabase } = await import('@/lib/server/db');
    const { store } = await import('@/lib/server/store');
    try {
      await openDatabase();
      store.reload();
      store.saveWorkflow({ id: 'wf_pg_store', name: 'Store on Postgres', nodes: [], connections: [] } as Workflow);
      store.saveExecution({ executionId: 'ex_pg_store', workflowId: 'wf_pg_store', workflowName: 'Store on Postgres', mode: 'trigger', status: 'success', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 3, runData: {}, executionOrder: [] });
      await closeDatabase();
      await openDatabase();
      store.reload();
      expect(store.getWorkflow('wf_pg_store')?.name).toBe('Store on Postgres');
      expect(store.getExecution('ex_pg_store')?.status).toBe('success');
      expect((await admin.query('SELECT status FROM executions WHERE id = $1', ['ex_pg_store'])).rows[0]?.status).toBe('success');
    } finally {
      await closeDatabase();
      for (const [key, value] of [['LANDFLOW_DB', previous.db], ['DATABASE_URL', previous.url], ['LANDFLOW_DATA_DIR', previous.dir]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      store.reload();
    }
  });
});
