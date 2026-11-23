/**
 * The Leases routes of Settings → External secrets (C30): GET /api/external-secrets/leases (admins; never a lease id
 * or a value) and POST /api/external-secrets/leases/revoke (one lease, every lease of a run, or set a failed one
 * aside; audited). A member is refused; a missing lease is a 404.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SecretLeaseRevokeResponse, SecretLeasesResponse } from '@/lib/shared/secrets';
import { fakeVaultLeases, VAULT_LEASES_TOKEN } from '@landflow/test-fakes/vault-leases';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-leases-routes-'));
const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' });

const auth = await import('@/lib/server/auth');
const { database } = await import('@/lib/server/db');
const secrets = await import('@/lib/server/secrets');
const leases = await import('@/lib/server/secrets/leases');
const listRoute = await import('@/app/api/external-secrets/leases/route');
const revokeRoute = await import('@/app/api/external-secrets/leases/revoke/route');

const bao = fakeVaultLeases();
const PATH = 'database/creds/report-reader';
let owner = '';
let member = '';

const call = async <T>(session: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const url = `http://localhost:3000/api/external-secrets/leases${path}`;
  const request = new Request(url, { method, headers: { cookie: `landflow_session=${session}`, origin: 'http://localhost:3000', ...(body !== undefined && { 'content-type': 'application/json' }) }, ...(body !== undefined && { body: JSON.stringify(body) }) });
  const response = await (method === 'GET' ? listRoute.GET(request) : revokeRoute.POST(request));
  return { status: response.status, body: (await response.json()) as T & { error?: string } };
};
const lease = (executionId: string, name = PATH) => leases.leasedSecret({ provider: 'bao', name }, { executionId, workflowId: 'wf_routes' });
const audits = (action: string) => database().all<{ actor_type: string; actor_name: string | null; details: string | null }>('SELECT actor_type, actor_name, details FROM audit_events WHERE action = ?', action);

beforeAll(async () => {
  auth.disableTestAuth();
  const ownerUser = await auth.createOwner({ email: 'owner@leases.test', name: 'Olive', password: 'password-123' });
  owner = auth.createSession(ownerUser, 'password').token;
  const memberUser = await auth.createUser({ email: 'mo@leases.test', name: 'Mo', role: 'member', password: 'password-123' });
  member = auth.createSession(memberUser, 'password').token;
  await bao.start();
  secrets.externalSecrets.create({ name: 'bao', kind: 'vault', settings: { url: bao.url, auth: 'token', token: VAULT_LEASES_TOKEN, dynamicMounts: 'database/' } });
});
afterAll(async () => {
  secrets.externalSecrets.closeAll();
  await bao.stop();
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});

describe('who may', () => {
  it('refuses a member and a signed-out caller on both routes', async () => {
    expect((await call(member, 'GET', '')).status).toBe(403);
    expect((await call(member, 'POST', '/revoke', { executionId: 'run_x' })).status).toBe(403);
    expect((await call('', 'GET', '')).status).toBe(401);
    expect((await call('', 'POST', '/revoke', { executionId: 'run_x' })).status).toBe(401);
  });
});

describe('listing', () => {
  it('lists leases with who, where and when, and never a lease id, a sealed value or a password', async () => {
    await lease('run_list_a');
    await lease('run_list_b');
    const { status, body } = await call<SecretLeasesResponse>(owner, 'GET', '');
    expect(status).toBe(200);
    expect(body.leases.map((l) => l.executionId).sort()).toEqual(['run_list_a', 'run_list_b']);
    expect(body.leases[0]).toMatchObject({ provider: 'bao', path: PATH, state: 'active', workflowId: 'wf_routes', attempts: 0 });
    expect(body.counts).toEqual({ active: 2, revokeFailed: 0 });
    const text = JSON.stringify(body);
    for (const issued of bao.state().issued) {
      expect(text).not.toContain(issued.password);
      expect(text).not.toContain(issued.username);
      expect(text).not.toContain(issued.leaseId);
    }
    expect(text).not.toContain('v2.');
    expect(text).not.toContain('lease_id');
    expect(text).not.toContain('lease_values');
  });

  it('filters by state and run, and pages by cursor', async () => {
    const one = await call<SecretLeasesResponse>(owner, 'GET', '?executionId=run_list_a');
    expect(one.body.leases.map((l) => l.executionId)).toEqual(['run_list_a']);
    const first = await call<SecretLeasesResponse>(owner, 'GET', '?limit=1');
    expect(first.body.leases).toHaveLength(1);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await call<SecretLeasesResponse>(owner, 'GET', `?limit=1&cursor=${first.body.nextCursor}`);
    expect(second.body.leases).toHaveLength(1);
    expect(second.body.leases[0].id).not.toBe(first.body.leases[0].id);
    expect(second.body.nextCursor).toBeUndefined();
    expect((await call<SecretLeasesResponse>(owner, 'GET', '?state=ended')).body.leases).toEqual([]);
    expect((await call(owner, 'GET', '?state=nope')).status).toBe(400);
    expect((await call(owner, 'GET', '?limit=0')).status).toBe(400);
    expect((await call(owner, 'GET', '?cursor=garbage')).status).toBe(400);
  });
});

describe('revoking', () => {
  it('revokes one lease now, and audits it as the person who pressed the button', async () => {
    const view = (await call<SecretLeasesResponse>(owner, 'GET', '?executionId=run_list_a')).body.leases[0];
    const { status, body } = await call<SecretLeaseRevokeResponse>(owner, 'POST', '/revoke', { id: view.id });
    expect(status).toBe(200);
    expect(body).toMatchObject({ revoked: 1, failed: 0 });
    expect(body.leases[0]).toMatchObject({ id: view.id, state: 'revoked', endedBy: 'admin' });
    expect(Object.keys(bao.state().active)).toHaveLength(1);
    expect(audits('secrets.lease.revoked')).toHaveLength(1);
    expect(audits('secrets.lease.revoked')[0]).toMatchObject({ actor_type: 'user', actor_name: 'Olive' });
    expect(audits('secrets.lease.revoked')[0].details).not.toContain(bao.state().issued[0].password);
  });

  it('revokes every lease of a run', async () => {
    await lease('run_all', PATH);
    await lease('run_all', 'database/creds/other-role');
    expect(Object.keys(bao.state().active)).toHaveLength(3);
    const { body } = await call<SecretLeaseRevokeResponse>(owner, 'POST', '/revoke', { executionId: 'run_all' });
    expect(body).toMatchObject({ revoked: 2, failed: 0 });
    expect(body.leases.map((l) => l.state)).toEqual(['revoked', 'revoked']);
    expect(Object.keys(bao.state().active)).toHaveLength(1);
  });

  it('answers with the reason and leaves the lease active when the store refuses', async () => {
    const view = (await call<SecretLeasesResponse>(owner, 'GET', '?state=active')).body.leases[0];
    bao.failNext('revoke', 1);
    const { status, body } = await call<SecretLeaseRevokeResponse>(owner, 'POST', '/revoke', { id: view.id });
    expect(status).toBe(200);
    expect(body).toMatchObject({ revoked: 0, failed: 1 });
    expect(body.leases[0]).toMatchObject({ state: 'active', attempts: 1, lastError: expect.stringContaining('500') });
  });

  it('sets a failed lease aside (audited) and refuses to set aside one that is not failed', async () => {
    const [failed] = (await call<SecretLeasesResponse>(owner, 'GET', '?state=active')).body.leases;
    database().upsert('secret_leases', { ...database().get<Record<string, string>>('SELECT * FROM secret_leases WHERE id = ?', failed.id)!, state: 'revoke_failed', ended_at: new Date().toISOString() });
    expect((await call<SecretLeasesResponse>(owner, 'GET', '')).body.counts.revokeFailed).toBe(1);
    const aside = await call<SecretLeaseRevokeResponse>(owner, 'POST', '/revoke', { id: failed.id, dismiss: true });
    expect(aside.body.leases[0]).toMatchObject({ state: 'revoke_failed', dismissed: true });
    expect(aside.body).toMatchObject({ revoked: 0, failed: 0 });
    expect((await call<SecretLeasesResponse>(owner, 'GET', '')).body.counts.revokeFailed).toBe(0);
    expect(audits('secrets.lease.dismissed')).toHaveLength(1);
    const notFailed = (await call<SecretLeasesResponse>(owner, 'GET', '?state=ended')).body.leases[0];
    expect((await call(owner, 'POST', '/revoke', { id: notFailed.id, dismiss: true })).status).toBe(409);
  });

  it('answers 404 for a lease that is not there and 400 for a body that names neither or both', async () => {
    expect((await call(owner, 'POST', '/revoke', { id: 'lease_nope' })).status).toBe(404);
    expect((await call<SecretLeaseRevokeResponse>(owner, 'POST', '/revoke', { executionId: 'run_nobody' })).body).toMatchObject({ revoked: 0, failed: 0, leases: [] });
    expect((await call(owner, 'POST', '/revoke', {})).status).toBe(400);
    expect((await call(owner, 'POST', '/revoke', { id: 'a', executionId: 'b' })).status).toBe(400);
    expect((await call(owner, 'POST', '/revoke', { id: 'a', extra: 1 })).status).toBe(400);
  });
});
