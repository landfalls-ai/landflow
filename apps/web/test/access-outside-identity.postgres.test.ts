/**
 * C36-A on a real Postgres (opt-in: LANDFLOW_INTEGRATION=postgres, or queue): two processes (each with its in-memory copy) click one sign-in link
 * and exactly one uses it; the three tables of migration 2936 round-trip with their Postgres types. Uses LANDFLOW_TEST_DATABASE_URL, default the
 * infra stack's `landflow_test` database, in a schema of its own (`landflow_outside_identity_test`, dropped after).
 */
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/server/db/database';

const BASE_URL = process.env.LANDFLOW_TEST_DATABASE_URL ?? 'postgres://landflow:landflow-dev-only@127.0.0.1:55432/landflow_test';
const SCHEMA = 'landflow_outside_identity_test';
const URL = `${BASE_URL}${BASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;
const flags = process.env.LANDFLOW_INTEGRATION?.split(',') ?? [];
const enabled = flags.includes('postgres') || flags.includes('queue');

vi.setConfig({ testTimeout: 60_000 });

describe.skipIf(!enabled)('outside sign-in on Postgres', async () => {
  const pg = (await import('pg')).default;
  const { openPostgres } = await import('@/lib/server/db/postgres');
  const store = await import('@/lib/server/access/outside/store');
  const admin = new pg.Pool({ connectionString: URL, max: 2 });
  const tmp = () => mkdtempSync(join(tmpdir(), 'landflow-pgoutside-'));
  const opened: Database[] = [];
  const previous = { mode: process.env.LANDFLOW_EXECUTIONS_MODE, dataDir: process.env.LANDFLOW_DATA_DIR };
  let main: Database;
  let worker: Database;
  const now = Date.parse('2030-01-01T09:00:00.000Z');
  const iso = (ms: number) => new Date(ms).toISOString();
  const hash = (token: string) => createHash('sha256').update(token).digest('hex');
  const link = (id: string, token: string, expires = now + 15 * 60_000) => ({ id, token_hash: hash(token), email_key: `${id}@partner.test`, email: `${id}@partner.test`, ip: '10.0.0.1', created_at: iso(now), expires_at: iso(expires), used_at: null });

  beforeAll(async () => {
    if (!/_test$/.test(new globalThis.URL(BASE_URL).pathname)) throw new Error(`Refusing to use ${BASE_URL}: its database name must end in _test`);
    process.env.LANDFLOW_EXECUTIONS_MODE = 'queue';
    process.env.LANDFLOW_DATA_DIR = tmp();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    main = await openPostgres(URL, tmp(), { instanceId: 'outside-main' });
    worker = await openPostgres(URL, tmp(), { instanceId: 'outside-worker' });
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

  it('round-trips the three tables', async () => {
    main.upsert('access_outside_requesters', { id: 'ext_rt', email: 'rt@partner.test', email_key: 'rt@partner.test', name: null, verified_by: 'link', google_subject: null, created_at: iso(now), last_verified_at: iso(now), last_seen_at: null, blocked_at: null, blocked_by: null });
    main.upsert('access_outside_links', link('ol_rt', 'round-trip'));
    main.upsert('access_outside_sessions', { id: 'os_rt', token_hash: hash('session'), requester_id: 'ext_rt', method: 'link', created_at: iso(now), expires_at: iso(now + 8 * 3_600_000), last_seen_at: iso(now), ip: null, user_agent: null });
    await main.flush();
    expect((await admin.query('SELECT email_key, verified_by FROM access_outside_requesters WHERE id = $1', ['ext_rt'])).rows[0]).toEqual({ email_key: 'rt@partner.test', verified_by: 'link' });
    expect((await admin.query('SELECT token_hash, used_at FROM access_outside_links WHERE id = $1', ['ol_rt'])).rows[0]).toEqual({ token_hash: hash('round-trip'), used_at: null });
    expect((await admin.query('SELECT requester_id, method FROM access_outside_sessions WHERE id = $1', ['os_rt'])).rows[0]).toEqual({ requester_id: 'ext_rt', method: 'link' });
    // The address is unique: a second requester with the same canonical address is refused.
    expect(() => main.upsert('access_outside_requesters', { id: 'ext_dup', email: 'rt@partner.test', email_key: 'rt@partner.test', name: null, verified_by: 'link', google_subject: null, created_at: iso(now), last_verified_at: iso(now), last_seen_at: null, blocked_at: null, blocked_by: null })).toThrow(/UNIQUE/);
  });

  it('lets exactly one of two processes (and ten clicks) use a link', async () => {
    main.upsert('access_outside_links', link('ol_race', 'race-token'));
    await main.flush();
    const clicks = Array.from({ length: 10 }, (_, i) => store.claimLink(hash('race-token'), now + 1000, i % 2 ? main : worker));
    const results = await Promise.all(clicks);
    expect(results.filter(Boolean)).toHaveLength(1);
    const row = (await admin.query('SELECT used_at FROM access_outside_links WHERE id = $1', ['ol_race'])).rows[0];
    expect(row.used_at).toEqual(iso(now + 1000));
    // Used up for both processes, and a later click finds nothing.
    expect(await store.claimLink(hash('race-token'), now + 2000, main)).toBeUndefined();
    expect(await store.claimLink(hash('race-token'), now + 2000, worker)).toBeUndefined();
  });

  it('does not use an expired or unknown link', async () => {
    main.upsert('access_outside_links', link('ol_late', 'late-token'));
    await main.flush();
    expect(await store.claimLink(hash('late-token'), now + 15 * 60_000 + 1000, worker)).toBeUndefined();
    expect(await store.claimLink(hash('never-sent'), now, worker)).toBeUndefined();
    expect((await admin.query('SELECT used_at FROM access_outside_links WHERE id = $1', ['ol_late'])).rows[0].used_at).toBeNull();
  });
});
