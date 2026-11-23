/**
 * C30: one lease row per (run, provider, path) across two processes on a real Postgres (opt-in: LANDFLOW_INTEGRATION=postgres).
 * A main and a worker (each with its in-memory copy) claim the same key at once: exactly one wins and both see the winner's
 * row (same sealed values). Uses LANDFLOW_TEST_DATABASE_URL, default the infra stack's `landflow_test` database, in a schema of
 * its own (`landflow_leases_test`, dropped after).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/server/db/database';

const BASE_URL = process.env.LANDFLOW_TEST_DATABASE_URL ?? 'postgres://landflow:landflow-dev-only@127.0.0.1:55432/landflow_test';
const SCHEMA = 'landflow_leases_test';
const URL = `${BASE_URL}${BASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;
const enabled = Boolean(process.env.LANDFLOW_INTEGRATION?.split(',').map((s) => s.trim()).includes('postgres'));

vi.setConfig({ testTimeout: 60_000 });

describe.skipIf(!enabled)('secret lease claims across two processes on Postgres', async () => {
  const pg = (await import('pg')).default;
  const { openPostgres } = await import('@/lib/server/db/postgres');
  const leases = await import('@/lib/server/secrets/leases');
  const admin = new pg.Pool({ connectionString: URL, max: 2 });
  const tmp = () => mkdtempSync(join(tmpdir(), 'landflow-pgleases-'));
  const opened: Database[] = [];
  const previous = { mode: process.env.LANDFLOW_EXECUTIONS_MODE, dataDir: process.env.LANDFLOW_DATA_DIR };
  let main: Database;
  let worker: Database;

  const row = (values: string): import('@/lib/server/secrets/leases').LeaseRow => ({
    id: leases.leaseRowId('run_pg', 'bao', 'database/creds/report-reader'),
    execution_id: 'run_pg',
    workflow_id: null,
    provider: 'bao',
    path: 'database/creds/report-reader',
    lease_id: 'sealed-id',
    lease_values: values,
    state: 'active',
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 900_000).toISOString(),
    renewed_until: null,
    attempts: 0,
    next_attempt_at: null,
    last_error: null,
    failing_since: null,
    dismissed_at: null,
    ended_at: null,
    ended_by: null,
  });

  beforeAll(async () => {
    if (!/_test$/.test(new globalThis.URL(BASE_URL).pathname)) throw new Error(`Refusing to use ${BASE_URL}: its database name must end in _test`);
    process.env.LANDFLOW_EXECUTIONS_MODE = 'queue';
    process.env.LANDFLOW_DATA_DIR = tmp();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    main = await openPostgres(URL, tmp(), { instanceId: 'lease-main' });
    worker = await openPostgres(URL, tmp(), { instanceId: 'lease-worker' });
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

  it('lets exactly one of twenty simultaneous claims of one key win, and every process sees the winner row', async () => {
    const claims = await Promise.all(Array.from({ length: 20 }, (_, i) => leases.claim(row(`values-${i}`), i % 2 ? main : worker)));
    expect(claims.filter((c) => c.won)).toHaveLength(1);
    const winner = claims.find((c) => c.won)!.row.lease_values;
    expect(new Set(claims.map((c) => c.row.lease_values))).toEqual(new Set([winner]));
    const rows = await admin.query('SELECT lease_values FROM secret_leases');
    expect(rows.rows).toEqual([{ lease_values: winner }]);
  });
});
