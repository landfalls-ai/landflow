/**
 * The use count of a capped API key across two processes on a real Postgres (opt-in: LANDFLOW_INTEGRATION=queue). A main and
 * a worker (each with its in-memory copy) fire calls at one key at once: exactly `cap` succeed, the count never passes the
 * cap, and each process's copy and the fresh read (`apiKeyUses`) agree with Postgres. Uses LANDFLOW_TEST_DATABASE_URL,
 * default the infra stack's `landflow_test` database, in a schema of its own (`landflow_api_key_uses_test`, dropped after).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/server/db/database';

const BASE_URL = process.env.LANDFLOW_TEST_DATABASE_URL ?? 'postgres://landflow:landflow-dev-only@127.0.0.1:55432/landflow_test';
const SCHEMA = 'landflow_api_key_uses_test';
const URL = `${BASE_URL}${BASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;
const enabled = Boolean(process.env.LANDFLOW_INTEGRATION?.split(',').includes('queue'));

vi.setConfig({ testTimeout: 60_000 });

describe.skipIf(!enabled)('API key use cap across two processes on Postgres', async () => {
  const pg = (await import('pg')).default;
  const { openPostgres } = await import('@/lib/server/db/postgres');
  const { consumeApiKeyUse, apiKeyUses } = await import('@/lib/server/auth/api-key-uses');
  const admin = new pg.Pool({ connectionString: URL, max: 2 });
  const tmp = () => mkdtempSync(join(tmpdir(), 'landflow-pgkeys-'));
  const opened: Database[] = [];
  const previous = { mode: process.env.LANDFLOW_EXECUTIONS_MODE, dataDir: process.env.LANDFLOW_DATA_DIR };
  let main: Database;
  let worker: Database;

  beforeAll(async () => {
    if (!/_test$/.test(new globalThis.URL(BASE_URL).pathname)) throw new Error(`Refusing to use ${BASE_URL}: its database name must end in _test`);
    process.env.LANDFLOW_EXECUTIONS_MODE = 'queue';
    process.env.LANDFLOW_DATA_DIR = tmp();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    main = await openPostgres(URL, tmp(), { instanceId: 'keys-main' });
    worker = await openPostgres(URL, tmp(), { instanceId: 'keys-worker' });
    opened.push(main, worker);
  });

  afterAll(async () => {
    for (const db of opened) await db.close().catch(() => {});
    for (const [key, value] of [['LANDFLOW_EXECUTIONS_MODE', previous.mode], ['LANDFLOW_DATA_DIR', previous.dataDir]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  it('lets exactly the cap through when two processes call at once (AS-4)', async () => {
    const key = { id: 'key_race', maxUses: 100 };
    const calls = Array.from({ length: 150 }, (_, i) => consumeApiKeyUse(key, i % 2 ? main : worker));
    const results = await Promise.all(calls);
    expect(results.filter((r) => r.ok)).toHaveLength(100);
    expect(results.filter((r) => !r.ok)).toHaveLength(50);
    const stored = await admin.query<{ uses: string }>('SELECT uses FROM api_key_uses WHERE key_id = $1', [key.id]);
    expect(Number(stored.rows[0].uses)).toBe(100);
    expect((await apiKeyUses([key.id], main)).get(key.id)).toBe(100);
    expect((await apiKeyUses([key.id], worker)).get(key.id)).toBe(100);
  });

  it('refuses at the cap with no off-by-one: a cap of 1 allows one call', async () => {
    const key = { id: 'key_one', maxUses: 1 };
    expect((await consumeApiKeyUse(key, main)).ok).toBe(true);
    expect((await consumeApiKeyUse(key, worker)).ok).toBe(false);
    expect((await consumeApiKeyUse(key, main)).ok).toBe(false);
    const stored = await admin.query<{ uses: string }>('SELECT uses FROM api_key_uses WHERE key_id = $1', [key.id]);
    expect(Number(stored.rows[0].uses)).toBe(1);
  });

  it('writes nothing for a key without a cap', async () => {
    expect(await consumeApiKeyUse({ id: 'key_free' }, main)).toEqual({ ok: true });
    const stored = await admin.query('SELECT 1 FROM api_key_uses WHERE key_id = $1', ['key_free']);
    expect(stored.rowCount).toBe(0);
  });
});
