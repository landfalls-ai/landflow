/**
 * C30 against the real OpenBao database engine of the landflow-infra stack (opt-in: LANDFLOW_INTEGRATION=secrets,postgres).
 * Run `deploy/scripts/openbao-db-engine.sh` first. A leased credential can log in to Postgres; after `revokeRun` it can't
 * and `pg_roles` no longer lists it; revoking a lease the store already dropped is "gone", not an error.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const flags = (process.env.LANDFLOW_INTEGRATION ?? '').split(',').map((s) => s.trim());
const ENABLED = flags.includes('secrets') && flags.includes('postgres');
const BAO = process.env.LANDFLOW_OPENBAO_URL ?? 'http://127.0.0.1:58200';
const ROOT = process.env.LANDFLOW_OPENBAO_TOKEN ?? 'landflow-dev-root-token';
const PG = process.env.LANDFLOW_LEASES_PG_URL ?? 'postgres://landflow:landflow-dev-only@127.0.0.1:55432/landflow_test';
const PATH = 'database/creds/report-reader';

vi.setConfig({ testTimeout: 60_000 });

describe.skipIf(!ENABLED)('leased Postgres credentials from OpenBao (landflow-infra)', async () => {
  const pg = (await import('pg')).default;
  const admin = new pg.Pool({ connectionString: PG, max: 2 });
  let leases: typeof import('@/lib/server/secrets/leases');
  let secrets: typeof import('@/lib/server/secrets');

  const loginAs = async (user: string, password: string) => {
    const url = new URL(PG);
    url.username = user;
    url.password = password;
    const client = new pg.Client({ connectionString: url.toString() });
    try {
      await client.connect();
      return (await client.query('SELECT current_user AS u')).rows[0].u as string;
    } finally {
      await client.end().catch(() => {});
    }
  };
  const roleExists = async (user: string) => (await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [user])).rowCount === 1;

  beforeAll(async () => {
    if (!/_test$/.test(new URL(PG).pathname)) throw new Error(`Refusing to use ${PG}: its database name must end in _test`);
    const dataDir = mkdtempSync(join(tmpdir(), 'landflow-leases-bao-'));
    Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
    secrets = await import('@/lib/server/secrets');
    leases = await import('@/lib/server/secrets/leases');
    secrets.externalSecrets.create({ name: 'bao', kind: 'vault', settings: { url: BAO, auth: 'token', token: ROOT, dynamicMounts: 'database/' } });
  });
  afterAll(async () => {
    secrets?.externalSecrets.closeAll();
    await admin.end();
  });

  it('issues a user that can log in, gives the run the same user twice, and removes it on revokeRun', async () => {
    const run = { executionId: `run_bao_${Date.now()}`, workflowId: 'wf_bao' };
    const first = (await leases.leasedSecret({ provider: 'bao', name: PATH }, run)) as { username: string; password: string };
    const again = (await leases.leasedSecret({ provider: 'bao', name: PATH }, run)) as { username: string };
    expect(again.username).toBe(first.username);
    expect(await loginAs(first.username, first.password)).toBe(first.username);
    expect(await roleExists(first.username)).toBe(true);

    const tally = await leases.revokeRun(run.executionId, 'finish');
    expect(tally).toMatchObject({ revoked: 1, failed: 0 });
    await expect(loginAs(first.username, first.password)).rejects.toThrow();
    expect(await roleExists(first.username)).toBe(false);
  });

  it('treats a lease the store already dropped as gone, not as a failure', async () => {
    const run = { executionId: `run_bao_gone_${Date.now()}`, workflowId: 'wf_bao' };
    const issued = (await leases.leasedSecret({ provider: 'bao', name: PATH }, run)) as { username: string };
    const row = leases.listLeases({ executionId: run.executionId }).leases[0];
    expect(row.state).toBe('active');
    await leases.revokeRun(run.executionId, 'finish');
    // second pass over the same run: nothing is left open
    expect(await leases.revokeRun(run.executionId, 'finish')).toMatchObject({ revoked: 0, failed: 0 });
    expect(await roleExists(issued.username)).toBe(false);
  });
});
