/**
 * Audit reliability (lib/server/audit/metrics.ts, `LANDFLOW_AUDIT_FAIL_CLOSED`): a failed audit insert is counted
 * (`landflow.audit.write_failures`); the change still happens by default; in fail-closed mode a role change, an API key,
 * a credential and a SCIM user are refused with 503 and nothing changes. The outbox gauges reflect a stuck destination.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-audit-reliability-'));
const ENV: Record<string, string> = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' };
const UNSET = ['LANDFLOW_OWNER_EMAIL', 'LANDFLOW_OWNER_PASSWORD', 'LANDFLOW_SCIM_GROUP_MAP', 'LANDFLOW_AUDIT_FAIL_CLOSED'];
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
for (const key of UNSET) delete process.env[key];

const auth = await import('@/lib/server/auth');
const { database } = await import('@/lib/server/db');
const { createApiKey, listApiKeys } = await import('@/lib/server/auth/api-keys');
const { queryEvents } = await import('@/lib/server/audit/store');
const { auditFailureTally, resetAuditFailureTally, outboxHealth } = await import('@/lib/server/audit/metrics');
const { recordAudit, AuditUnavailableError } = await import('@/lib/server/audit');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const apiKeysRoute = await import('@/app/api/api-keys/route');
const userRoute = await import('@/app/api/users/[id]/route');
const credentialsRoute = await import('@/app/api/credentials/route');
const scimUsers = await import('@/app/scim/v2/Users/route');

registry.registerBuiltin(corePlugin);

afterAll(() => {
  auth.enableTestAuth();
  for (const key of [...Object.keys(ENV), ...UNSET]) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});
beforeAll(() => auth.enableTestAuth());

let broken: ReturnType<typeof vi.spyOn> | undefined;
/** Make every insert into the audit table fail (disk full, a lock, a schema problem). */
function breakAuditWrites() {
  const db = database();
  const real = db.insertNew.bind(db);
  broken = vi.spyOn(db, 'insertNew').mockImplementation(((table: string, row: Record<string, unknown>) => {
    if (table === 'audit_events') throw new Error('database or disk is full');
    return real(table as never, row as never);
  }) as never);
}
afterEach(() => {
  broken?.mockRestore();
  broken = undefined;
  delete process.env.LANDFLOW_AUDIT_FAIL_CLOSED;
  resetAuditFailureTally();
});

const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost:3000${path}`, { method, headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...headers }, ...(body !== undefined && { body: JSON.stringify(body) }) });
const params = (value: Record<string, string>) => ({ params: Promise.resolve(value) });
const events = (action: string) => queryEvents({ action: [action] }, { limit: 100 }).events;

describe('audit write failures', () => {
  it('counts a failed write and lets the change go on by default', async () => {
    const member = await auth.createUser({ email: 'm1@reliability.test', name: 'M1', role: 'member', password: 'member-password-1' });
    breakAuditWrites();
    const response = await userRoute.PATCH(req('PATCH', `/api/users/${member.id}`, { role: 'admin' }), params({ id: member.id }));
    expect(response.status).toBe(200);
    expect(auth.getUser(member.id)?.role).toBe('admin');
    expect(auditFailureTally().writes['user.role_change']).toBe(1);
    expect(events('user.role_change')).toHaveLength(0);
  });

  it('refuses a role change, an API key and a credential with 503 in fail-closed mode, and changes nothing', async () => {
    const member = await auth.createUser({ email: 'm2@reliability.test', name: 'M2', role: 'member', password: 'member-password-1' });
    const keysBefore = listApiKeys(auth.getUser(member.id)!.id).length;
    const allKeys = () => Number(database().get<{ n: number }>('SELECT COUNT(*) AS n FROM api_keys')?.n);
    const before = allKeys();
    breakAuditWrites();
    process.env.LANDFLOW_AUDIT_FAIL_CLOSED = 'true';

    const role = await userRoute.PATCH(req('PATCH', `/api/users/${member.id}`, { role: 'admin' }), params({ id: member.id }));
    expect(role.status).toBe(503);
    expect(auth.getUser(member.id)?.role).toBe('member');

    const key = await apiKeysRoute.POST(req('POST', '/api/api-keys', { label: 'CI', scopes: ['workflows:read'] }));
    expect(key.status).toBe(503);
    expect(allKeys()).toBe(before);
    expect(keysBefore).toBe(0);

    const list = async () => ((await (await credentialsRoute.GET(req('GET', '/api/credentials'))).json()) as { credentials: unknown[] }).credentials.length;
    const credentialsBefore = await list();
    const credential = await credentialsRoute.POST(req('POST', '/api/credentials', { name: 'Refused', type: 'core.httpBearerAuth', data: { token: 'abc' } }));
    expect(credential.status).toBe(503);
    expect(await list()).toBe(credentialsBefore);
    expect(auditFailureTally().writes['credential.create']).toBeGreaterThan(0);
  });

  it('refuses SCIM provisioning with 503 in fail-closed mode and leaves no user behind', async () => {
    auth.disableTestAuth();
    const owner = await auth.createUser({ email: 'olive@reliability.test', name: 'Olive', role: 'owner', password: 'owner-password-1' });
    const { token } = createApiKey(owner, { label: 'Okta', scopes: ['scim'] });
    const post = () =>
      scimUsers.POST(
        new Request('http://localhost:3000/scim/v2/Users', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ userName: 'ann@example.com', displayName: 'Ann' }) }),
        { params: Promise.resolve({}) } as never,
      );
    breakAuditWrites();
    process.env.LANDFLOW_AUDIT_FAIL_CLOSED = 'true';
    expect((await post()).status).toBe(503);
    expect(auth.findUserByEmail('ann@example.com')).toBeUndefined();

    delete process.env.LANDFLOW_AUDIT_FAIL_CLOSED;
    expect((await post()).status).toBe(201);
    expect(auth.findUserByEmail('ann@example.com')).toBeDefined();
    auth.enableTestAuth();
  });

  it('throws AuditUnavailableError for a required event only in fail-closed mode', () => {
    breakAuditWrites();
    const input = { action: 'settings.update', target: { type: 'settings', id: 'audit' } };
    expect(recordAudit(input, { required: true })).toBeUndefined();
    process.env.LANDFLOW_AUDIT_FAIL_CLOSED = 'true';
    expect(() => recordAudit(input, { required: true })).toThrow(AuditUnavailableError);
    expect(recordAudit(input)).toBeUndefined();
  });

  it('stores the events once the database works again', async () => {
    process.env.LANDFLOW_AUDIT_FAIL_CLOSED = 'true';
    const member = await auth.createUser({ email: 'm3@reliability.test', name: 'M3', role: 'member', password: 'member-password-1' });
    expect((await userRoute.PATCH(req('PATCH', `/api/users/${member.id}`, { role: 'admin' }), params({ id: member.id }))).status).toBe(200);
    expect(events('user.role_change').some((event) => event.target?.id === member.id)).toBe(true);
  });
});

describe('outbox gauges', () => {
  it('report the depth and the age of a stuck destination', () => {
    const db = database();
    const old = new Date(Date.now() - 120_000).toISOString();
    db.insertNew('audit_outbox', { destination_id: 'dest_stuck', event_id: 'aud_a', created_at: old, attempts: 5, next_at: old, lease_until: null, last_error: 'timeout' });
    db.insertNew('audit_outbox', { destination_id: 'dest_stuck', event_id: 'aud_b', created_at: new Date().toISOString(), attempts: 5, next_at: old, lease_until: null, last_error: 'timeout' });
    const health = outboxHealth('dest_stuck');
    expect(health.depth).toBe(2);
    expect(health.oldestAgeSeconds).toBeGreaterThanOrEqual(119);
    expect(outboxHealth('dest_none')).toEqual({ depth: 0, oldestAgeSeconds: 0 });
  });
});
