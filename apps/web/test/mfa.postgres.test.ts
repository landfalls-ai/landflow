/**
 * C16 / P15a: the second factor's one-use decisions in queue mode on a real Postgres (opt-in: LANDFLOW_INTEGRATION=queue).
 * Two processes (each with its in-memory copy) take the same sign-in challenge, recovery code and TOTP step at once:
 * exactly one wins each, and the loser's copy learns of it. Uses LANDFLOW_TEST_DATABASE_URL, default the infra stack's
 * `landflow_test` database, in a schema of its own (`landflow_mfa_test`, dropped after).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/server/db/database';

const BASE_URL = process.env.LANDFLOW_TEST_DATABASE_URL ?? 'postgres://landflow:landflow-dev-only@127.0.0.1:55432/landflow_test';
const SCHEMA = 'landflow_mfa_test';
const URL = `${BASE_URL}${BASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;
const enabled = Boolean(process.env.LANDFLOW_INTEGRATION?.split(',').includes('queue'));

vi.setConfig({ testTimeout: 60_000 });

describe.skipIf(!enabled)('second-factor one-use decisions in queue mode on Postgres', async () => {
  const pg = (await import('pg')).default;
  const { openPostgres } = await import('@/lib/server/db/postgres');
  const { takeOnce } = await import('@/lib/server/auth/mfa/once');
  const admin = new pg.Pool({ connectionString: URL, max: 2 });
  const tmp = () => mkdtempSync(join(tmpdir(), 'landflow-pgmfa-'));
  const opened: Database[] = [];
  const until = (check: () => void) => vi.waitFor(check, { timeout: 15_000, interval: 50 });
  const previous = { mode: process.env.LANDFLOW_EXECUTIONS_MODE, dataDir: process.env.LANDFLOW_DATA_DIR };
  let main: Database;
  let worker: Database;


  beforeAll(async () => {
    if (!/_test$/.test(new globalThis.URL(BASE_URL).pathname)) throw new Error(`Refusing to use ${BASE_URL}: its database name must end in _test`);
    process.env.LANDFLOW_EXECUTIONS_MODE = 'queue';
    // Nothing here may reach the default data directory.
    process.env.LANDFLOW_DATA_DIR = tmp();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    main = await openPostgres(URL, tmp(), { instanceId: 'chain-main' });
    worker = await openPostgres(URL, tmp(), { instanceId: 'chain-worker' });
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

  const now = () => new Date().toISOString();
  const until5 = () => new Date(Date.now() + 5 * 60_000).toISOString();

  it('of two mains using the same challenge at once, exactly one wins, and both copies learn it', async () => {
    for (let i = 0; i < 10; i++) {
      const id = `chal_${i}`;
      (i % 2 ? main : worker).insertNew('mfa_challenges', { id, user_id: 'usr_a', purpose: 'sign-in', first_method: 'password', wrong: 0, created_at: now(), expires_at: until5(), used_at: null });
      const take = (db: Database) => takeOnce({ table: 'mfa_challenges', key: { id }, set: { used_at: now() }, when: 'used_at IS NULL AND expires_at > ?', whenParams: [now()], check: (row) => !row.used_at }, db);
      const won = await Promise.all([take(main), take(worker)]);
      expect(won.filter(Boolean)).toHaveLength(1);
      await until(() => expect([main, worker].map((db) => db.get<{ used_at: string | null }>('SELECT used_at FROM mfa_challenges WHERE id = ?', id)?.used_at)).toEqual([expect.any(String), expect.any(String)]));
    }
  });

  it('of two mains giving the same recovery code, one wins', async () => {
    main.insertNew('user_recovery_codes', { user_id: 'usr_b', code_hash: 'h1', created_at: now(), used_at: null });
    const take = (db: Database) => takeOnce({ table: 'user_recovery_codes', key: { user_id: 'usr_b', code_hash: 'h1' }, set: { used_at: now() }, when: 'used_at IS NULL', whenParams: [], check: (row) => !row.used_at }, db);
    expect((await Promise.all([take(main), take(worker)])).filter(Boolean)).toHaveLength(1);
    expect(await take(worker)).toBeUndefined();
  });

  it('of two mains using the same TOTP step, one wins, and a step at or below the last is refused', async () => {
    main.insertNew('user_mfa_factors', { id: 'fac_1', user_id: 'usr_c', kind: 'totp', name: 'App', secret: 's', created_at: now() });
    const claim = (db: Database, step: number) => takeOnce({ table: 'user_mfa_factors', key: { id: 'fac_1' }, set: { last_step: step }, when: 'last_step IS NULL OR last_step < ?', whenParams: [step], check: (row) => row.last_step == null || Number(row.last_step) < step }, db);
    expect((await Promise.all([claim(main, 100), claim(worker, 100)])).filter(Boolean)).toHaveLength(1);
    expect(await claim(worker, 99)).toBeUndefined();
    expect(await claim(main, 101)).toBeDefined();
  });

  it('counts wrong answers on the row in Postgres, so two mains can not each give five', async () => {
    main.insertNew('mfa_challenges', { id: 'chal_w', user_id: 'usr_a', purpose: 'sign-in', first_method: 'password', wrong: 0, created_at: now(), expires_at: until5(), used_at: null });
    const bump = (db: Database) => takeOnce({ table: 'mfa_challenges', key: { id: 'chal_w' }, set: { wrong: { $inc: 1 } }, when: 'wrong < ?', whenParams: [5], check: (row) => Number(row.wrong) < 5 }, db);
    const results = await Promise.all(Array.from({ length: 8 }, (_v, i) => bump(i % 2 ? main : worker)));
    expect(results.filter(Boolean)).toHaveLength(5);
  });
});
