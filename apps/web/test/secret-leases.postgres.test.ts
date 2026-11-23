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
import { fakeVaultLeases, VAULT_LEASES_TOKEN } from '@landflow/test-fakes/vault-leases';

const BASE_URL = process.env.LANDFLOW_TEST_DATABASE_URL ?? 'postgres://landflow:landflow-dev-only@127.0.0.1:55432/landflow_test';
const SCHEMA = 'landflow_leases_test';
const URL = `${BASE_URL}${BASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;
const enabled = Boolean(process.env.LANDFLOW_INTEGRATION?.split(',').map((s) => s.trim()).includes('postgres'));

vi.setConfig({ testTimeout: 60_000 });

describe.skipIf(!enabled)('secret lease claims across two processes on Postgres', async () => {
  const pg = (await import('pg')).default;
  const { openPostgres } = await import('@/lib/server/db/postgres');
  const leases = await import('@/lib/server/secrets/leases');
  const { leaseSweeper } = await import('@/lib/server/secrets/lease-sweeper');
  const { credentials } = await import('@/lib/server/credentials/vault');
  const secrets = await import('@/lib/server/secrets');
  const bao = fakeVaultLeases();
  const admin = new pg.Pool({ connectionString: URL, max: 2 });
  const tmp = () => mkdtempSync(join(tmpdir(), 'landflow-pgleases-'));
  const opened: Database[] = [];
  const previous = { mode: process.env.LANDFLOW_EXECUTIONS_MODE, dataDir: process.env.LANDFLOW_DATA_DIR };
  let main: Database;
  let worker: Database;
  let leader: Database;
  const waitFor = async (check: () => unknown, ms = 10_000) => {
    for (const stop = Date.now() + ms; Date.now() < stop; await new Promise((r) => setTimeout(r, 100))) if (check()) return true;
    return false;
  };

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
    renew_failures: 0,
    renewable: 1,
  });

  beforeAll(async () => {
    if (!/_test$/.test(new globalThis.URL(BASE_URL).pathname)) throw new Error(`Refusing to use ${BASE_URL}: its database name must end in _test`);
    process.env.LANDFLOW_EXECUTIONS_MODE = 'queue';
    process.env.LANDFLOW_DATA_DIR = tmp();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    main = await openPostgres(URL, tmp(), { instanceId: 'lease-main' });
    worker = await openPostgres(URL, tmp(), { instanceId: 'lease-worker' });
    leader = await openPostgres(URL, tmp(), { instanceId: 'lease-leader' });
    opened.push(main, worker, leader);
    // The provider (and the fake store behind it) live in this process's own copy, whichever process swept.
    process.env.LANDFLOW_EXECUTIONS_MODE = previous.mode ?? 'memory';
    if (previous.mode === undefined) delete process.env.LANDFLOW_EXECUTIONS_MODE;
    await bao.start();
    secrets.externalSecrets.create({ name: 'bao', kind: 'vault', settings: { url: bao.url, auth: 'token', token: VAULT_LEASES_TOKEN, dynamicMounts: 'database/', leaseTtl: 900 } });
  });

  afterAll(async () => {
    for (const db of opened) await db.close().catch(() => {});
    for (const [key, value] of [['LANDFLOW_EXECUTIONS_MODE', previous.mode], ['LANDFLOW_DATA_DIR', previous.dataDir]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    secrets.externalSecrets.closeAll();
    await bao.stop();
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

  it('shows a worker’s lease to the leader, whose sweeper revokes it once its run is over, and to nobody else a second time', async () => {
    const path = 'database/creds/report-reader';
    const issued = await secrets.externalSecrets.issue('bao', path);
    const id = leases.leaseRowId('run_pg_sweep', 'bao', path);
    const lease = {
      ...row('x'),
      id,
      execution_id: 'run_pg_sweep',
      lease_id: credentials.sealSecret(issued.leaseId, `secrets.lease.id:${id}`),
      lease_values: credentials.sealSecret(JSON.stringify(issued.values), `secrets.lease:${id}`),
      issued_at: new Date().toISOString(),
    };
    expect((await leases.claim(lease, worker)).won).toBe(true);
    // Postgres has it, and the other processes hear of it (they would sweep, renew, list and count it).
    expect(await waitFor(() => leader.get('SELECT id FROM secret_leases WHERE id = ?', id)), 'the leader sees the worker’s lease').toBe(true);
    expect(main.get('SELECT id FROM secret_leases WHERE id = ?', id)).toBeTruthy();

    const later = Date.now() + 10 * 60_000;
    const swept = await leaseSweeper.tick(later, leader);
    expect(swept.revoked).toBe(1);
    expect(bao.state().revoked).toEqual([issued.leaseId]);
    expect((await admin.query('SELECT state, ended_by FROM secret_leases WHERE id = $1', [id])).rows[0]).toEqual({ state: 'revoked', ended_by: 'sweeper' });
    // Another process's sweep finds nothing open: the credential is revoked once.
    await waitFor(() => main.get<{ state: string }>('SELECT state FROM secret_leases WHERE id = ?', id)?.state === 'revoked');
    expect((await leaseSweeper.tick(later, main)).revoked).toBe(0);
    expect(bao.state().revoked).toHaveLength(1);
  });
});
