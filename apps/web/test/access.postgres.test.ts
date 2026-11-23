/**
 * C35 on a real Postgres (opt-in: LANDFLOW_INTEGRATION=postgres, or queue): two processes (each with its in-memory copy) claim the same due
 * grant and one wins; two approvals of one request record one decision; the four tables round-trip with their Postgres types. Uses
 * LANDFLOW_TEST_DATABASE_URL, default the infra stack's `landflow_test` database, in a schema of its own (`landflow_access_test`, dropped after).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/server/db/database';

const BASE_URL = process.env.LANDFLOW_TEST_DATABASE_URL ?? 'postgres://landflow:landflow-dev-only@127.0.0.1:55432/landflow_test';
const SCHEMA = 'landflow_access_test';
const URL = `${BASE_URL}${BASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;
const flags = process.env.LANDFLOW_INTEGRATION?.split(',') ?? [];
const enabled = flags.includes('postgres') || flags.includes('queue');

vi.setConfig({ testTimeout: 60_000 });

describe.skipIf(!enabled)('access requests on Postgres', async () => {
  const pg = (await import('pg')).default;
  const { openPostgres } = await import('@/lib/server/db/postgres');
  const store = await import('@/lib/server/access/store');
  const admin = new pg.Pool({ connectionString: URL, max: 2 });
  const tmp = () => mkdtempSync(join(tmpdir(), 'landflow-pgaccess-'));
  const opened: Database[] = [];
  const previous = { mode: process.env.LANDFLOW_EXECUTIONS_MODE, dataDir: process.env.LANDFLOW_DATA_DIR };
  let main: Database;
  let worker: Database;
  const now = new Date('2030-01-01T09:00:00.000Z').toISOString();

  const request = (id: string) => ({ id, entry_id: 'ae_1', entry_version: 1, entry_snapshot: '{"name":"Team"}', requester_id: `usr_${id}`, account: 'mia-gh', duration_minutes: 60, reason: 'Fixing the build', channel: 'form', status: 'pending', approvers: '["usr_ann"]', workflow_id: 'wf_1', execution_id: `ex_${id}`, decisions: null, approved_minutes: null, note: null, question: null, created_at: now, updated_at: now });
  const grant = (id: string, until: string | null) => ({ id, request_id: null, entry_id: 'ae_1', holder_id: 'usr_mia', account: 'mia-gh', system: 'github-team', target: '{"config":{}}', credential_id: null, status: 'active', since: now, until, approved_by: 'usr_ann', already_had: 0, lease_until: null, attempts: 0, next_attempt_at: null, ended_at: null, ended_by: null, end_reason: null, last_error: null, checked_at: null, overdue_noted: 0, remove_reason: null, remove_by: null, target_key: null, created_at: now, updated_at: now });

  beforeAll(async () => {
    if (!/_test$/.test(new globalThis.URL(BASE_URL).pathname)) throw new Error(`Refusing to use ${BASE_URL}: its database name must end in _test`);
    process.env.LANDFLOW_EXECUTIONS_MODE = 'queue';
    process.env.LANDFLOW_DATA_DIR = tmp();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    main = await openPostgres(URL, tmp(), { instanceId: 'access-main' });
    worker = await openPostgres(URL, tmp(), { instanceId: 'access-worker' });
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

  it('round-trips the four tables with their types', async () => {
    main.upsert('access_entries', { id: 'ae_1', name: 'Team', description: null, system: 'github-team', target: '{}', credential_id: null, durations: '[60,null]', steps: '[]', owners: '[]', eligible: '[]', enabled: 1, version: 3, created_by: null, created_at: now, updated_at: now });
    main.upsert('access_requests', request('areq_rt'));
    main.upsert('access_grants', grant('ag_rt', null));
    main.upsert('access_accounts', { user_id: 'usr_mia', system: 'github', handle: 'mia-gh', updated_at: now });
    await main.flush();
    const entry = (await admin.query('SELECT * FROM access_entries WHERE id = $1', ['ae_1'])).rows[0];
    expect(entry).toMatchObject({ name: 'Team', version: '3' });
    expect(Number(entry.enabled)).toBe(1);
    expect((await admin.query('SELECT duration_minutes, status FROM access_requests WHERE id = $1', ['areq_rt'])).rows[0]).toMatchObject({ duration_minutes: '60', status: 'pending' });
    expect((await admin.query('SELECT until, overdue_noted FROM access_grants WHERE id = $1', ['ag_rt'])).rows[0]).toMatchObject({ until: null });
    expect((await admin.query('SELECT handle FROM access_accounts WHERE user_id = $1 AND system = $2', ['usr_mia', 'github'])).rows[0]).toEqual({ handle: 'mia-gh' });
  });

  it('lets exactly one of two processes remove a due grant', async () => {
    main.upsert('access_grants', grant('ag_race', new Date(Date.parse(now) - 1000).toISOString()));
    await main.flush();
    const claims = Array.from({ length: 10 }, (_, i) => store.claimGrant('ag_race', 'active', { status: 'removing', end_reason: 'expired' }, { leaseMs: 600_000 }, i % 2 ? main : worker));
    const results = await Promise.all(claims);
    expect(results.filter((r) => r.won)).toHaveLength(1);
    const row = (await admin.query('SELECT status, end_reason, lease_until FROM access_grants WHERE id = $1', ['ag_race'])).rows[0];
    expect(row).toMatchObject({ status: 'removing', end_reason: 'expired' });
    expect(row.lease_until).toEqual(expect.any(String));
    // The loser sees the winner's row, not its own.
    expect(results.find((r) => !r.won)!.row).toMatchObject({ status: 'removing' });
  });

  it('records one decision when two approvals of one request arrive together', async () => {
    main.upsert('access_requests', request('areq_two'));
    await main.flush();
    const [a, b] = await Promise.all([
      store.claimRequest('areq_two', 'pending', { status: 'approved', decisions: '[{"by":"ann"}]', approved_minutes: 15 }, main),
      store.claimRequest('areq_two', 'pending', { status: 'approved', decisions: '[{"by":"ben"}]', approved_minutes: 60 }, worker),
    ]);
    expect([a.won, b.won].filter(Boolean)).toHaveLength(1);
    const row = (await admin.query('SELECT status, decisions, approved_minutes FROM access_requests WHERE id = $1', ['areq_two'])).rows[0];
    expect(row.status).toBe('approved');
    expect(JSON.parse(row.decisions)).toHaveLength(1);
    // A denial after the approval changes nothing.
    const late = await store.claimRequest('areq_two', 'pending', { status: 'denied' }, worker);
    expect(late.won).toBe(false);
    expect((await admin.query('SELECT status FROM access_requests WHERE id = $1', ['areq_two'])).rows[0].status).toBe('approved');
  });
});
