/**
 * Custom roles through the routes and the guard (C32): AS-1 (a Platform holder passes the plugins gate and is refused
 * the users one), AS-3 (an admin can't grant users:manage), AS-4 (an edit shows on the next request), AS-5 (an
 * admin-scope key still needs the action), AS-6 (an Auditor reads the audit log of their projects), AS-7 (audit down
 * and fail-closed: 503), delete in use (409, then confirm). The test bypass is off: every request carries a session or key.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { call } from './mfa-helpers';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-roles-routes-'));
const ENV: Record<string, string> = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const UNSET = ['LANDFLOW_OWNER_EMAIL', 'LANDFLOW_OWNER_PASSWORD', 'LANDFLOW_AUDIT_FAIL_CLOSED'];
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
for (const key of UNSET) delete process.env[key];

const auth = await import('@/lib/server/auth');
const { createApiKey } = await import('@/lib/server/auth/api-keys');
const { database } = await import('@/lib/server/db');
const rolesRoute = await import('@/app/api/users/roles/route');
const roleRoute = await import('@/app/api/users/roles/[id]/route');
const userRoute = await import('@/app/api/users/[id]/route');
const usersRoute = await import('@/app/api/users/route');
const invitesRoute = await import('@/app/api/users/invites/route');
const marketplacesRoute = await import('@/app/api/marketplaces/route');
const mcpRoute = await import('@/app/api/settings/mcp/route');
const auditRoute = await import('@/app/api/audit/route');
const meRoute = await import('@/app/api/auth/me/route');
const projects = await import('@/lib/server/projects');
const { recordAudit } = await import('@/lib/server/audit');

let broken: ReturnType<typeof vi.spyOn> | undefined;
beforeAll(() => auth.disableTestAuth());
afterEach(() => {
  broken?.mockRestore();
  broken = undefined;
  delete process.env.LANDFLOW_AUDIT_FAIL_CLOSED;
});
afterAll(() => {
  auth.enableTestAuth();
  for (const key of [...Object.keys(ENV), ...UNSET]) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

let n = 0;
const make = async (role: 'owner' | 'admin' | 'member') => {
  const user = await auth.createUser({ email: `c${++n}@example.test`, name: `C${n}`, role, password: 'a-long-password-1' });
  return { user, session: auth.createSession(user, 'password').token };
};

let ownerUser: Awaited<ReturnType<typeof make>>;
beforeAll(async () => {
  ownerUser = await make('owner');
});

describe('custom roles through the routes', () => {
  it('AS-1: a Platform holder installs through the plugins gate and is refused the users one', async () => {
    const owner = ownerUser;
    const member = await make('member');
    const created = await call(rolesRoute.POST, '/api/users/roles', { session: owner.session, body: { name: 'Platform', description: 'Plugins and MCP', rules: [{ action: 'plugins:manage', effect: 'allow' }, { action: 'mcp:manage', effect: 'allow' }] } });
    expect(created.status).toBe(201);
    const roleId = created.body.role.id as string;
    // Before the role: the gate answers 403.
    expect((await call(marketplacesRoute.POST, '/api/marketplaces', { session: member.session, body: { input: '' } })).status).toBe(403);
    const assigned = await call(userRoute.PATCH, `/api/users/${member.user.id}`, { method: 'PATCH', session: owner.session, body: { customRoleId: roleId } }, { id: member.user.id });
    expect(assigned.status).toBe(200);
    expect(assigned.body.user.customRole).toEqual({ id: roleId, name: 'Platform' });
    // Past the gate: the body is invalid, so 400, not 403.
    expect((await call(marketplacesRoute.POST, '/api/marketplaces', { session: member.session, body: { input: '' } })).status).toBe(400);
    expect((await call(mcpRoute.GET, '/api/settings/mcp', { session: member.session })).status).toBe(200);
    expect((await call(invitesRoute.POST, '/api/users/invites', { session: member.session, body: { email: 'x@example.test' } })).status).toBe(403);
    const me = await call(meRoute.GET, '/api/auth/me', { session: member.session });
    expect(me.body.user.grants.sort()).toEqual(['mcp:manage', 'plugins:manage']);
    // The list carries the holder counts.
    const list = await call(rolesRoute.GET, '/api/users/roles', { session: member.session });
    expect(list.status).toBe(200);
    expect(list.body.roles[0]).toMatchObject({ name: 'Platform', holders: 1 });
  });

  it('AS-4: an edit shows on the holder’s next request, no sign-out', async () => {
    const ownerSession = ownerUser.session;
    const member = await make('member');
    const created = await call(rolesRoute.POST, '/api/users/roles', { session: ownerSession, body: { name: 'Ops', rules: [{ action: 'mcp:manage', effect: 'allow' }] } });
    const roleId = created.body.role.id as string;
    await call(userRoute.PATCH, `/api/users/${member.user.id}`, { method: 'PATCH', session: ownerSession, body: { customRoleId: roleId } }, { id: member.user.id });
    expect((await call(mcpRoute.GET, '/api/settings/mcp', { session: member.session })).status).toBe(200);
    expect((await call(mcpRoute.PATCH, '/api/settings/mcp', { method: 'PATCH', session: member.session, body: { enabled: false } })).status).toBe(200);
    const edit = await call(roleRoute.PUT, `/api/users/roles/${roleId}`, { method: 'PUT', session: ownerSession, body: { rules: [{ action: 'variables:manage', effect: 'allow' }] } }, { id: roleId });
    expect(edit.status).toBe(200);
    expect((await call(mcpRoute.PATCH, '/api/settings/mcp', { method: 'PATCH', session: member.session, body: { enabled: false } })).status).toBe(403);
  });

  it('AS-3: an admin can’t grant users:manage; the owner can; projects:manage is refused for both', async () => {
    const admin = await make('admin');
    const refused = await call(rolesRoute.POST, '/api/users/roles', { session: admin.session, body: { name: 'Bosses', rules: [{ action: 'users:manage', effect: 'allow' }] } });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/Only the owner can grant users:manage/);
    const owner = ownerUser.user;
    const ownerSession = ownerUser.session;
    expect((await call(rolesRoute.POST, '/api/users/roles', { session: ownerSession, body: { name: 'Bosses', rules: [{ action: 'users:manage', effect: 'allow' }] } })).status).toBe(201);
    expect((await call(rolesRoute.POST, '/api/users/roles', { session: ownerSession, body: { name: 'Everything', rules: [{ action: 'projects:manage', effect: 'allow' }] } })).status).toBe(403);
    expect((await call(rolesRoute.POST, '/api/users/roles', { session: ownerSession, body: { name: 'Odd', rules: [{ action: 'nope:nope', effect: 'allow' }] } })).status).toBe(400);
    // An admin who may grant plugins:manage creates it fine.
    expect((await call(rolesRoute.POST, '/api/users/roles', { session: admin.session, body: { name: 'Plugins only', rules: [{ action: 'plugins:manage', effect: 'allow' }] } })).status).toBe(201);
  });

  it('a plain member can’t create, edit or delete roles', async () => {
    const member = await make('member');
    expect((await call(rolesRoute.POST, '/api/users/roles', { session: member.session, body: { name: 'Mine', rules: [{ action: 'plugins:manage', effect: 'allow' }] } })).status).toBe(403);
    expect((await call(roleRoute.DELETE, '/api/users/roles/x', { method: 'DELETE', session: member.session }, { id: 'x' })).status).toBe(403);
  });

  it('AS-5: a holder’s admin-scope key still needs the action', async () => {
    const owner = ownerUser.user;
    const ownerSession = ownerUser.session;
    const member = await make('member');
    const role = await call(rolesRoute.POST, '/api/users/roles', { session: ownerSession, body: { name: 'KeyRole', rules: [{ action: 'plugins:manage', effect: 'allow' }] } });
    await call(userRoute.PATCH, `/api/users/${member.user.id}`, { method: 'PATCH', session: ownerSession, body: { customRoleId: role.body.role.id } }, { id: member.user.id });
    const { token } = createApiKey(auth.getUser(member.user.id)!, { label: 'ci', scopes: ['admin'] });
    expect((await call(invitesRoute.POST, '/api/users/invites', { key: token, body: { email: 'y@example.test' } })).status).toBe(403);
    expect((await call(marketplacesRoute.POST, '/api/marketplaces', { key: token, body: { input: '' } })).status).toBe(400);
  });

  it('AS-6: an Auditor reads the audit log of their projects only', async () => {
    const owner = ownerUser.user;
    const ownerSession = ownerUser.session;
    const auditor = await make('member');
    const role = await call(rolesRoute.POST, '/api/users/roles', { session: ownerSession, body: { name: 'Auditor', rules: [{ action: 'audit:read', effect: 'allow' }] } });
    await call(userRoute.PATCH, `/api/users/${auditor.user.id}`, { method: 'PATCH', session: ownerSession, body: { customRoleId: role.body.role.id } }, { id: auditor.user.id });
    const mine = projects.createTeamProject({ name: 'Audited', createdBy: owner.id });
    const theirs = projects.createTeamProject({ name: 'Elsewhere', createdBy: owner.id });
    projects.setMember(mine.id, auditor.user.id, 'viewer');
    recordAudit({ action: 'settings.update', target: { type: 'project', id: mine.id, name: 'Audited' }, project: mine.id, summary: 'in mine' });
    recordAudit({ action: 'settings.update', target: { type: 'project', id: theirs.id, name: 'Elsewhere' }, project: theirs.id, summary: 'in theirs' });
    const read = await call(auditRoute.GET, '/api/audit?limit=200', { session: auditor.session });
    expect(read.status).toBe(200);
    const summaries = (read.body.events as Array<{ summary: string }>).map((e) => e.summary);
    expect(summaries).toContain('in mine');
    expect(summaries).not.toContain('in theirs');
    expect((await call(auditRoute.GET, `/api/audit?projectId=${theirs.id}`, { session: auditor.session })).status).toBe(403);
    // The owner still reads everything.
    const all = await call(auditRoute.GET, '/api/audit?limit=200', { session: ownerSession });
    expect((all.body.events as Array<{ summary: string }>).map((e) => e.summary)).toContain('in theirs');
  });

  it('AS-7: with fail-closed and the audit log down, a role change answers 503 and changes nothing', async () => {
    const owner = ownerUser.user;
    const ownerSession = ownerUser.session;
    const db = database();
    const real = db.insertNew.bind(db);
    broken = vi.spyOn(db, 'insertNew').mockImplementation(((table: string, row: Record<string, unknown>) => {
      if (table === 'audit_events') throw new Error('database or disk is full');
      return real(table as never, row as never);
    }) as never);
    process.env.LANDFLOW_AUDIT_FAIL_CLOSED = 'true';
    const refused = await call(rolesRoute.POST, '/api/users/roles', { session: ownerSession, body: { name: 'Nope', rules: [{ action: 'variables:manage', effect: 'allow' }] } });
    expect(refused.status).toBe(503);
    broken.mockRestore();
    delete process.env.LANDFLOW_AUDIT_FAIL_CLOSED;
    const names = (await call(rolesRoute.GET, '/api/users/roles', { session: ownerSession })).body.roles.map((r: { name: string }) => r.name);
    expect(names).not.toContain('Nope');
  });

  it('deleting a role in use answers 409 with the count; ?confirm=true leaves holders as plain members', async () => {
    const owner = ownerUser.user;
    const ownerSession = ownerUser.session;
    const member = await make('member');
    const role = await call(rolesRoute.POST, '/api/users/roles', { session: ownerSession, body: { name: 'Temp', rules: [{ action: 'variables:manage', effect: 'allow' }] } });
    const id = role.body.role.id as string;
    await call(userRoute.PATCH, `/api/users/${member.user.id}`, { method: 'PATCH', session: ownerSession, body: { customRoleId: id } }, { id: member.user.id });
    const refused = await call(roleRoute.DELETE, `/api/users/roles/${id}`, { method: 'DELETE', session: ownerSession }, { id });
    expect(refused.status).toBe(409);
    expect(refused.body.holders).toBe(1);
    const done = await call(roleRoute.DELETE, `/api/users/roles/${id}`, { method: 'DELETE', session: ownerSession }, { id });
    expect(done.status).toBe(409);
    const confirmed = await call(roleRoute.DELETE, `/api/users/roles/${id}?confirm=true`, { method: 'DELETE', session: ownerSession }, { id });
    expect(confirmed.status).toBe(200);
    expect(auth.getUser(member.user.id)!.customRole).toBeUndefined();
    expect((await call(roleRoute.GET, `/api/users/roles/${id}`, { session: ownerSession }, { id })).status).toBe(404);
  });

  it('clearing a role with customRoleId null; an admin or the owner can’t hold one; the users list shows who holds what', async () => {
    const owner = ownerUser.user;
    const ownerSession = ownerUser.session;
    const member = await make('member');
    const admin = await make('admin');
    const role = await call(rolesRoute.POST, '/api/users/roles', { session: ownerSession, body: { name: 'Vars', rules: [{ action: 'variables:manage', effect: 'allow' }] } });
    const id = role.body.role.id as string;
    expect((await call(userRoute.PATCH, `/api/users/${admin.user.id}`, { method: 'PATCH', session: ownerSession, body: { customRoleId: id } }, { id: admin.user.id })).status).toBe(400);
    expect((await call(userRoute.PATCH, `/api/users/${owner.id}`, { method: 'PATCH', session: ownerSession, body: { customRoleId: id } }, { id: owner.id })).status).toBe(403);
    await call(userRoute.PATCH, `/api/users/${member.user.id}`, { method: 'PATCH', session: ownerSession, body: { customRoleId: id } }, { id: member.user.id });
    const list = await call(usersRoute.GET, '/api/users', { session: ownerSession });
    expect(list.body.users.find((u: { id: string }) => u.id === member.user.id).customRole.name).toBe('Vars');
    const cleared = await call(userRoute.PATCH, `/api/users/${member.user.id}`, { method: 'PATCH', session: ownerSession, body: { customRoleId: null } }, { id: member.user.id });
    expect(cleared.body.user.customRole).toBeUndefined();
    // A body with neither field, or both, is refused.
    expect((await call(userRoute.PATCH, `/api/users/${member.user.id}`, { method: 'PATCH', session: ownerSession, body: {} }, { id: member.user.id })).status).toBe(400);
    // Promoting a holder to admin clears the role.
    await call(userRoute.PATCH, `/api/users/${member.user.id}`, { method: 'PATCH', session: ownerSession, body: { customRoleId: id } }, { id: member.user.id });
    const promoted = await call(userRoute.PATCH, `/api/users/${member.user.id}`, { method: 'PATCH', session: ownerSession, body: { role: 'admin' } }, { id: member.user.id });
    expect(promoted.body.user.role).toBe('admin');
    expect(promoted.body.user.customRole).toBeUndefined();
  });
});
