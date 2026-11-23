/**
 * C30 review fixes: a run is named explicitly (never inferred from a request id), an unsealable lease id is a failed revoke,
 * an ended row is never written back to active, renew failures and revoke attempts are counted apart and a non-renewable
 * lease is not renewed, a lost claim revokes its own credential, sealed values are bound to their row, and the lease
 * routes are for the built-in owner and admin only.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecuteRequest } from '@landflow/protocol';
import type { ResolvedNodeType } from '@landflow/engine';
import { fakeVaultLeases, VAULT_LEASES_TOKEN } from '@landflow/test-fakes/vault-leases';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-leases-review-'));
const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' });
delete process.env.LANDFLOW_ENVIRONMENT;

const auth = await import('@/lib/server/auth');
const roles = await import('@/lib/server/auth/roles');
const { routePolicy } = await import('@/lib/server/auth/policy');
const { database } = await import('@/lib/server/db');
const { credentials } = await import('@/lib/server/credentials/vault');
const secrets = await import('@/lib/server/secrets');
const leases = await import('@/lib/server/secrets/leases');
const { leaseSweeper } = await import('@/lib/server/secrets/lease-sweeper');
const { withExternalSecrets } = await import('@/lib/server/secrets/runtime');
const listRoute = await import('@/app/api/external-secrets/leases/route');
const revokeRoute = await import('@/app/api/external-secrets/leases/revoke/route');

const bao = fakeVaultLeases();
const slow = fakeVaultLeases({ renewable: false });
const PATH = 'database/creds/report-reader';
const ref = { provider: 'bao', name: PATH };
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const row = (executionId: string, provider = 'bao') => database().get<Record<string, string | number | null>>('SELECT * FROM secret_leases WHERE execution_id = ? AND provider = ?', executionId, provider)!;
const setRun = (id: string, status: string) => database().upsert('executions', { id, workflow_id: 'wf_review', status, mode: 'manual', started_at: iso(Date.now() - 5 * MIN), summary: '{}', data: '{}' });
const audits = (action: string) => database().all<{ id: string }>('SELECT id FROM audit_events WHERE action = ?', action);

beforeAll(async () => {
  await bao.start();
  await slow.start();
  secrets.externalSecrets.create({ name: 'bao', kind: 'vault', settings: { url: bao.url, auth: 'token', token: VAULT_LEASES_TOKEN, dynamicMounts: 'database/', leaseTtl: 900 } });
  secrets.externalSecrets.create({ name: 'slow', kind: 'vault', settings: { url: slow.url, auth: 'token', token: VAULT_LEASES_TOKEN, dynamicMounts: 'database/', leaseTtl: 900 } });
});
beforeEach(() => {
  bao.reset();
  slow.reset();
  database().delete('secret_leases', { provider: 'bao' });
  database().delete('secret_leases', { provider: 'slow' });
});
afterAll(async () => {
  secrets.externalSecrets.closeAll();
  leaseSweeper.stop();
  await bao.stop();
  await slow.stop();
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});

describe('a run is named, never inferred (#2)', () => {
  const credentialsOf = { postgres: { user: `{{ $secrets.bao['${PATH}'].username }}` } };
  const node = (seen: unknown[]): ResolvedNodeType => ({ execute: async (request: ExecuteRequest) => (seen.push(request.credentials), { outputs: [[]] }) }) as unknown as ResolvedNodeType;
  const request = (executionId: string): ExecuteRequest => ({ executionId, workflowId: 'wf_review', nodeId: 'n', credentials: credentialsOf }) as unknown as ExecuteRequest;

  it('issues nothing for the synthetic ids of agent channels, MCP lists and run changes, and says why', async () => {
    const seen: unknown[] = [];
    const wrapped = withExternalSecrets(node(seen));
    for (const id of ['agch_abc123', 'mcp_list_abc123', 'ex_real:changes']) {
      await expect(wrapped.execute(request(id), {})).rejects.toThrow(/issued per run: use it in a node credential/);
    }
    expect(bao.state().issued).toHaveLength(0);
    expect(database().all('SELECT * FROM secret_leases')).toHaveLength(0);
  });

  it('issues to the run the engine names in the call', async () => {
    const seen: Array<Record<string, { user: string }>> = [];
    const wrapped = withExternalSecrets(node(seen));
    await wrapped.execute(request('ex_named'), { secretRun: { executionId: 'ex_named', workflowId: 'wf_review' } });
    expect(seen[0].postgres.user).toBe(bao.state().issued[0].username);
    expect(row('ex_named')).toMatchObject({ state: 'active', workflow_id: 'wf_review' });
  });
});

describe('a lease id that can’t be unsealed (#3)', () => {
  const put = (executionId: string, over: Record<string, unknown>) =>
    database().upsert('secret_leases', {
      id: leases.leaseRowId(executionId, 'bao', PATH), execution_id: executionId, provider: 'bao', path: PATH, state: 'active', issued_at: iso(Date.now()), expires_at: iso(Date.now() + 15 * MIN), attempts: 0, ...over,
    });

  it('is a failed revoke: counted, retried on a backoff, the row stays active with the reason', async () => {
    put('run_unseal', { lease_id: 'v2.k0.not-a-sealed-string' });
    expect(await leases.revokeRun('run_unseal', 'finish')).toEqual({ revoked: 0, failed: 1 });
    expect(row('run_unseal')).toMatchObject({ state: 'active', attempts: 1, last_error: expect.stringMatching(/can.t be unsealed/) });
    expect(row('run_unseal').next_attempt_at).toBeTruthy();
    expect(bao.state().revoked).toHaveLength(0);
  });

  it('has nothing to revoke only when there is no lease id at all', async () => {
    put('run_noid', { lease_id: null });
    expect(await leases.revokeRun('run_noid', 'finish')).toEqual({ revoked: 1, failed: 0 });
    expect(row('run_noid').state).toBe('revoked');
  });
});

describe('a run that waited past its lease, and a lost claim (#5)', () => {
  it('gets the clear 409 and no second user', async () => {
    await leases.leasedSecret(ref, { executionId: 'run_late' });
    database().upsert('secret_leases', { ...row('run_late'), expires_at: iso(Date.now() - 1000) });
    await expect(leases.leasedSecret(ref, { executionId: 'run_late' })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/ended \(expired\) before this node asked for it/) });
    expect(bao.state().issued).toHaveLength(1);
  });

  it('revokes the credential it issued and uses the winner’s values when another process claimed first', async () => {
    const id = leases.leaseRowId('run_race', 'bao', PATH);
    const real = secrets.externalSecrets.issue.bind(secrets.externalSecrets);
    const spy = vi.spyOn(secrets.externalSecrets, 'issue').mockImplementationOnce(async (provider, name) => {
      const issued = await real(provider, name);
      // The other process wins the claim while this one's issue is in flight.
      database().upsert('secret_leases', {
        id, execution_id: 'run_race', provider: 'bao', path: PATH, state: 'active', issued_at: iso(Date.now()), expires_at: iso(Date.now() + 15 * MIN), attempts: 0,
        lease_id: credentials.sealSecret('database/creds/report-reader/winner', `secrets.lease.id:${id}`),
        lease_values: credentials.sealSecret(JSON.stringify({ username: 'winner-user', password: 'winner-password' }), `secrets.lease:${id}`),
      });
      return issued;
    });
    const values = (await leases.leasedSecret(ref, { executionId: 'run_race' })) as { username: string };
    spy.mockRestore();
    expect(values.username).toBe('winner-user');
    expect(bao.state().revoked).toEqual([bao.state().issued[0].leaseId]);
    expect(bao.state().active).toEqual({});
  });
});

describe('an ended row is never written back (#6)', () => {
  it('a renewal that finishes after the lease was revoked leaves it revoked', async () => {
    await leases.leasedSecret(ref, { executionId: 'run_ghost' });
    const stale = row('run_ghost') as unknown as import('@/lib/server/secrets/leases').LeaseRow;
    await leases.revokeRun('run_ghost', 'finish');
    expect(await leases.renewRow(stale, Date.now())).toBe(false);
    expect(row('run_ghost').state).toBe('revoked');
  });

  it('an expiry decided on an old read leaves a revoked lease revoked, with no second audit event', async () => {
    await leases.leasedSecret(ref, { executionId: 'run_ghost2' });
    const stale = row('run_ghost2') as unknown as import('@/lib/server/secrets/leases').LeaseRow;
    await leases.revokeRun('run_ghost2', 'finish');
    const before = audits('secrets.lease.expired').length;
    await leases.expireRow(stale, Date.now());
    expect(row('run_ghost2').state).toBe('revoked');
    expect(audits('secrets.lease.expired')).toHaveLength(before);
  });
});

describe('renewing (#7)', () => {
  it('counts renew failures apart from revoke attempts', async () => {
    const start = Date.now();
    setRun('run_rf', 'running');
    await leases.leasedSecret(ref, { executionId: 'run_rf' });
    database().upsert('secret_leases', { ...row('run_rf'), expires_at: iso(start + MIN) });
    bao.down();
    await leaseSweeper.tick(start);
    expect(row('run_rf')).toMatchObject({ state: 'active', attempts: 0, renew_failures: 1 });
    expect(Date.parse(String(row('run_rf').next_attempt_at)) - start).toBe(30_000);
  });

  it('does not ask a store to renew a lease it said is not renewable, and lets it run out', async () => {
    const start = Date.now();
    setRun('run_nr', 'running');
    await leases.leasedSecret({ provider: 'slow', name: PATH }, { executionId: 'run_nr' });
    expect(Number(row('run_nr', 'slow').renewable)).toBe(0);
    database().upsert('secret_leases', { ...row('run_nr', 'slow'), expires_at: iso(start + MIN) });
    const result = await leaseSweeper.tick(start);
    expect(result.renewed).toBe(0);
    expect(slow.state().issued[0].renewals).toBe(0);
    expect(row('run_nr', 'slow')).toMatchObject({ state: 'active', renew_failures: 0 });
    await leaseSweeper.tick(start + 2 * MIN);
    expect(row('run_nr', 'slow').state).toBe('expired');
  });
});

describe('sealed to the row (#9)', () => {
  it('seals the values and the id under purposes that name the row', async () => {
    await leases.leasedSecret(ref, { executionId: 'run_purpose' });
    const r = row('run_purpose');
    expect(JSON.parse(credentials.openSecret(String(r.lease_values), `secrets.lease:${r.id}`))).toMatchObject({ username: bao.state().issued[0].username });
    expect(credentials.openSecret(String(r.lease_id), `secrets.lease.id:${r.id}`)).toBe(bao.state().issued[0].leaseId);
    expect(() => credentials.openSecret(String(r.lease_values), 'secrets.lease')).toThrow();
  });
});

describe('who may (#8)', () => {
  let n = 0;
  it('names both lease routes instance-wide in the route policy', () => {
    expect(routePolicy('GET', '/api/external-secrets/leases')).toMatchObject({ action: 'settings:manage', instanceAdmin: true });
    expect(routePolicy('POST', '/api/external-secrets/leases/revoke')).toMatchObject({ instanceAdmin: true });
  });

  it('refuses a custom-role holder with settings:manage on both, and lets an admin through', async () => {
    auth.disableTestAuth();
    const owner = await auth.createOwner({ email: 'owner@review.test', name: 'Olive', password: 'password-123' });
    const admin = await auth.createUser({ email: 'admin@review.test', name: 'Ada', role: 'admin', password: 'password-123' });
    const holder = await auth.createUser({ email: `holder${++n}@review.test`, name: 'Hal', role: 'member', password: 'password-123' });
    const role = roles.createRole({ name: 'Settings holder', rules: [{ action: 'settings:manage', effect: 'allow' }] }, auth.getUser(owner.id)!);
    roles.assignRole(holder.id, role.id, auth.getUser(owner.id)!);
    const cookie = (user: typeof holder) => `landflow_session=${auth.createSession(auth.getUser(user.id)!, 'password').token}`;
    const call = (route: (r: Request) => Promise<Response>, method: string, user: typeof holder, body?: unknown) =>
      route(new Request('http://localhost:3000/api/external-secrets/leases', { method, headers: { cookie: cookie(user), origin: 'http://localhost:3000', ...(body && { 'content-type': 'application/json' }) }, ...(body && { body: JSON.stringify(body) }) }));
    expect((await call(listRoute.GET, 'GET', holder)).status).toBe(403);
    expect((await call(revokeRoute.POST, 'POST', holder, { executionId: 'run_x' })).status).toBe(403);
    expect((await call(listRoute.GET, 'GET', admin)).status).toBe(200);
    auth.enableTestAuth();
  });
});
