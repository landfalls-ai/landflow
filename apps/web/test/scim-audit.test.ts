/**
 * SCIM audit events (lib/server/scim/audit.ts): creating, renaming, deactivating, reactivating and deleting a user
 * and changing a group's members each record one event as the token's user and key id, with before and after values;
 * a rejected token records one `scim.auth_failed` per client address per minute.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-scim-audit-'));
const ENV: Record<string, string> = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' };
const UNSET = ['LANDFLOW_OWNER_EMAIL', 'LANDFLOW_OWNER_PASSWORD', 'LANDFLOW_SCIM_GROUP_MAP'];
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
for (const key of UNSET) delete process.env[key];

const auth = await import('@/lib/server/auth');
const { createApiKey } = await import('@/lib/server/auth/api-keys');
const { queryEvents } = await import('@/lib/server/audit/store');
const usersRoute = await import('@/app/scim/v2/Users/route');
const userRoute = await import('@/app/scim/v2/Users/[id]/route');
const groupsRoute = await import('@/app/scim/v2/Groups/route');
const groupRoute = await import('@/app/scim/v2/Groups/[id]/route');

beforeAll(() => auth.disableTestAuth());
afterAll(() => {
  auth.enableTestAuth();
  for (const key of [...Object.keys(ENV), ...UNSET]) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

type Route = (request: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;

let token = '';
let keyId = '';
let ownerId = '';

async function scim(route: unknown, method: string, path: string, body?: unknown, id?: string, headers: Record<string, string> = {}) {
  const request = new Request(`http://localhost:3000${path}`, {
    method,
    headers: { 'x-forwarded-for': '10.9.0.1', 'user-agent': 'okta-test', ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const response = await (route as Route)(request, id ? { params: Promise.resolve({ id }) } : { params: Promise.resolve({}) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as Record<string, any> };
}

const events = (action: string) => queryEvents({ action: [action] }, { limit: 100 }).events;
const patch = (...Operations: unknown[]) => ({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations });

describe('SCIM audit events', () => {
  let userId = '';
  let otherId = '';
  let groupId = '';

  it('sets up a SCIM token', async () => {
    const owner = await auth.createUser({ email: 'olive@scim-audit.test', name: 'Olive', role: 'owner', password: 'owner-password-1' });
    ownerId = owner.id;
    const created = createApiKey(owner, { label: 'Okta', scopes: ['scim'] });
    token = created.token;
    keyId = created.key.id;
  });

  it('records a provisioned user as the token’s user with its values', async () => {
    const created = await scim(usersRoute.POST, 'POST', '/scim/v2/Users', { userName: 'Ann@Example.com', displayName: 'Ann', externalId: 'ext-1', active: true }, undefined, { authorization: `Bearer ${token}` });
    expect(created.status).toBe(201);
    userId = created.body.id;
    const found = events('user.provision');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      outcome: 'success',
      actor: { type: 'api_key', id: ownerId },
      apiKeyId: keyId,
      target: { type: 'user', id: userId },
      details: { email: 'ann@example.com', name: 'Ann', role: 'member', active: true, externalId: 'ext-1' },
      userAgent: 'okta-test',
    });
  });

  it('records a rename, a deactivation and a reactivation, one event each', async () => {
    const headers = { authorization: `Bearer ${token}` };
    expect((await scim(userRoute.PATCH, 'PATCH', `/scim/v2/Users/${userId}`, patch({ op: 'replace', path: 'displayName', value: 'Ann Lee' }), userId, headers)).status).toBe(200);
    const updates = events('user.update');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ target: { id: userId }, apiKeyId: keyId, details: { nameFrom: 'Ann', nameTo: 'Ann Lee' } });
    expect(events('user.deactivate')).toHaveLength(0);

    await scim(userRoute.PATCH, 'PATCH', `/scim/v2/Users/${userId}`, patch({ op: 'replace', value: { active: false } }), userId, headers);
    expect(events('user.deactivate')).toHaveLength(1);
    expect(events('user.deactivate')[0]).toMatchObject({ target: { id: userId }, apiKeyId: keyId, details: { activeFrom: true, activeTo: false } });
    expect(events('user.update')).toHaveLength(1);

    await scim(userRoute.PATCH, 'PATCH', `/scim/v2/Users/${userId}`, patch({ op: 'replace', value: { active: true } }), userId, headers);
    expect(events('user.reactivate')).toHaveLength(1);
    expect(events('user.reactivate')[0]).toMatchObject({ details: { activeFrom: false, activeTo: true } });
  });

  it('records a group and its member changes', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const other = await scim(usersRoute.POST, 'POST', '/scim/v2/Users', { userName: 'bo@example.com', displayName: 'Bo' }, undefined, headers);
    otherId = other.body.id;
    const made = await scim(groupsRoute.POST, 'POST', '/scim/v2/Groups', { displayName: 'Data', members: [{ value: userId }] }, undefined, headers);
    expect(made.status).toBe(201);
    groupId = made.body.id;
    expect(events('group.create')[0]).toMatchObject({ target: { type: 'group', id: groupId }, apiKeyId: keyId, details: { displayName: 'Data', members: 1 } });
    expect(events('group.members_change')).toHaveLength(1);

    await scim(groupRoute.PATCH, 'PATCH', `/scim/v2/Groups/${groupId}`, patch({ op: 'add', path: 'members', value: [{ value: otherId }] }, { op: 'remove', path: `members[value eq "${userId}"]` }), groupId, headers);
    const changes = events('group.members_change');
    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({ target: { id: groupId }, details: { added: [otherId], removed: [userId] } });

    await scim(groupRoute.PATCH, 'PATCH', `/scim/v2/Groups/${groupId}`, patch({ op: 'replace', path: 'displayName', value: 'Data Team' }), groupId, headers);
    expect(events('group.update')[0]).toMatchObject({ details: { displayNameFrom: 'Data', displayNameTo: 'Data Team' } });

    expect((await scim(groupRoute.DELETE, 'DELETE', `/scim/v2/Groups/${groupId}`, undefined, groupId, headers)).status).toBe(204);
    expect(events('group.remove')[0]).toMatchObject({ target: { id: groupId }, details: { displayName: 'Data Team', members: [otherId] } });
  });

  it('records a deleted user', async () => {
    expect((await scim(userRoute.DELETE, 'DELETE', `/scim/v2/Users/${userId}`, undefined, userId, { authorization: `Bearer ${token}` })).status).toBe(204);
    const removed = events('user.remove');
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ target: { id: userId, name: 'ann@example.com' }, apiKeyId: keyId, details: { role: 'member' } });
  });

  it('records a rejected token once per address per minute', async () => {
    const bad = { authorization: 'Bearer lf_not-a-real-key-at-all' };
    expect((await scim(usersRoute.GET, 'GET', '/scim/v2/Users', undefined, undefined, bad)).status).toBe(401);
    expect((await scim(usersRoute.GET, 'GET', '/scim/v2/Users', undefined, undefined, bad)).status).toBe(401);
    expect(events('scim.auth_failed')).toHaveLength(1);
    expect(events('scim.auth_failed')[0]).toMatchObject({ outcome: 'denied', actor: { type: 'anonymous' }, ip: '10.9.0.1', details: { status: 401 } });
    // Another address is its own window.
    await scim(usersRoute.GET, 'GET', '/scim/v2/Users', undefined, undefined, { ...bad, 'x-forwarded-for': '10.9.0.2' });
    expect(events('scim.auth_failed')).toHaveLength(2);
  });

  it('names the key and its user when a valid key is refused (403)', async () => {
    const plain = createApiKey((await auth.getUser(ownerId))!, { label: 'Not SCIM', scopes: ['workflows:read'] });
    const refused = await scim(usersRoute.GET, 'GET', '/scim/v2/Users', undefined, undefined, { authorization: `Bearer ${plain.token}`, 'x-forwarded-for': '10.9.0.3' });
    expect(refused.status).toBe(403);
    const found = events('scim.auth_failed').find((event: { ip?: string }) => event.ip === '10.9.0.3');
    expect(found).toMatchObject({ details: { status: 403, keyId: plain.key.id, userId: ownerId } });
  });

  it('records at most 60 rejected tokens a minute across every address', async () => {
    const { recordScimAuthFailure } = await import('@/lib/server/scim/audit');
    const before = events('scim.auth_failed').length;
    // A new minute far from the requests above, so the window starts clean.
    const at = Date.now() + 10 * 60_000;
    for (let i = 0; i < 100; i++) recordScimAuthFailure(`10.10.${Math.floor(i / 250)}.${i % 250}`, 401, 'Invalid SCIM token', undefined, at);
    expect(queryEvents({ action: ['scim.auth_failed'] }, { limit: 500 }).events.length - before).toBe(60);
  });

  it('records the role change a mapped group causes as one user.update', async () => {
    process.env.LANDFLOW_SCIM_GROUP_MAP = 'Admins=role:admin';
    try {
      const headers = { authorization: `Bearer ${token}` };
      const made = await scim(usersRoute.POST, 'POST', '/scim/v2/Users', { userName: 'cy@example.com', displayName: 'Cy', externalId: 'ext-cy' }, undefined, headers);
      const cyId = made.body.id;
      const updatesBefore = events('user.update').length;
      expect((await scim(groupsRoute.POST, 'POST', '/scim/v2/Groups', { displayName: 'Admins', members: [{ value: cyId }] }, undefined, headers)).status).toBe(201);
      const updates = events('user.update');
      expect(updates.length - updatesBefore).toBe(1);
      expect(updates[0]).toMatchObject({ target: { id: cyId }, apiKeyId: keyId, details: { roleFrom: 'member', roleTo: 'admin' } });
    } finally {
      delete process.env.LANDFLOW_SCIM_GROUP_MAP;
    }
  });
});
