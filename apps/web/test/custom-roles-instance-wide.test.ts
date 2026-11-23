/**
 * Custom roles, the second escalation review (C32, 2026-11-23): instance-wide power stays with the built-in owner and
 * admin. Instance-wide writes carry `instanceAdmin` in the route policy and the guard refuses a holder; a SCIM token of a
 * non-owner changes only what its person could (no admin promotions on an admin's token, no project grants for projects
 * its person doesn't administer, no accounts it couldn't change through /Users); a user manager with a custom role acts
 * only on people within projects they administer and never sees a reset link; MCP grants re-check stored credentials.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call } from './mfa-helpers';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-roles-wide-'));
const ENV: Record<string, string> = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const UNSET = ['LANDFLOW_OWNER_EMAIL', 'LANDFLOW_OWNER_PASSWORD', 'LANDFLOW_SCIM_GROUP_MAP'];
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
for (const key of UNSET) delete process.env[key];

const auth = await import('@/lib/server/auth');
const roles = await import('@/lib/server/auth/roles');
const groups = await import('@/lib/server/scim/groups');
const scimUsers = await import('@/lib/server/scim/users');
const grants = await import('@/lib/server/mcp/grants');
const projects = await import('@/lib/server/projects');
const store = await import('@/lib/server/projects/store');
const { routePolicy } = await import('@/lib/server/auth/policy');
const userScope = await import('@/lib/server/auth/user-scope');
const { credentials } = await import('@/lib/server/credentials/vault');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
registry.registerBuiltin(corePlugin);
const settingsRoute = await import('@/app/api/settings/route');
const resetRoute = await import('@/app/api/users/[id]/password-reset/route');
const userRoute = await import('@/app/api/users/[id]/route');
const { isBuiltInAdmin } = await import('@/lib/shared/auth');

beforeAll(() => auth.disableTestAuth());
afterAll(() => {
  auth.enableTestAuth();
  for (const key of [...Object.keys(ENV), ...UNSET]) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

let n = 0;
const rule = (action: string) => ({ action, effect: 'allow' as const });
const fresh = (id: string) => auth.getUser(id)!;
const make = async (role: 'owner' | 'admin' | 'member', extra: { provisionedBy?: 'scim'; externalId?: string } = {}) => {
  const user = await auth.createUser({ email: `w${++n}@example.test`, name: `W${n}`, role, password: 'a-long-password-1', ...extra });
  return { user, session: auth.createSession(user, 'password').token };
};
const principalOf = (user: ReturnType<typeof fresh>) => ({ user, via: 'api-key' as const, apiKey: { id: 'key_w', scopes: ['scim' as const] } });
const asToken = <T>(user: ReturnType<typeof fresh>, fn: () => T): T => auth.withAuth({ principal: principalOf(user) }, fn);

let owner: Awaited<ReturnType<typeof make>>;
let admin: Awaited<ReturnType<typeof make>>;
beforeAll(async () => {
  owner = await make('owner');
  admin = await make('admin');
});

describe('instance-wide writes need the built-in admin role', () => {
  it('names them in the route policy; reads and project-level routes are unchanged', () => {
    const wide: Array<[string, string]> = [
      ['POST', '/api/settings/mcp/policy-hooks'], ['POST', '/api/mcp/gateway/sync'], ['PATCH', '/api/settings/governance'], ['PATCH', '/api/settings'], ['POST', '/api/settings/prune'],
      ['POST', '/api/settings/audit/destinations'], ['POST', '/api/external-secrets'], ['POST', '/api/llm-gateway/keys'], ['POST', '/api/llm-gateway/sync'], ['POST', '/api/transports'],
      ['POST', '/api/brain/run'], ['PUT', '/api/variables/KEY'], ['POST', '/api/variables'], ['PUT', '/api/settings/security'],
    ];
    for (const [method, path] of wide) expect(routePolicy(method, path), `${method} ${path}`).toMatchObject({ instanceAdmin: true });
    for (const [method, path] of [['GET', '/api/variables'], ['GET', '/api/settings/mcp'], ['POST', '/api/mcp/grants'], ['PUT', '/api/projects/p1/variables/KEY']] as const) {
      expect(routePolicy(method, path).instanceAdmin, `${method} ${path}`).toBeUndefined();
    }
  });

  it('the guard refuses a settings:manage holder on PATCH /api/settings and lets an admin through', async () => {
    const role = roles.createRole({ name: 'Settings holder', rules: [rule('settings:manage')] }, fresh(owner.user.id));
    const holder = await make('member');
    roles.assignRole(holder.user.id, role.id, fresh(owner.user.id));
    const refused = await call(settingsRoute.PATCH, '/api/settings', { method: 'PATCH', session: holder.session, body: { timezone: 'UTC' } });
    expect(refused.status).toBe(403);
    expect((await call(settingsRoute.PATCH, '/api/settings', { method: 'PATCH', session: admin.session, body: { timezone: 'UTC' } })).status).toBe(200);
  });

  it('isBuiltInAdmin is the owner and admin role, never a custom role', () => {
    expect(isBuiltInAdmin({ role: 'owner' })).toBe(true);
    expect(isBuiltInAdmin({ role: 'admin' })).toBe(true);
    expect(isBuiltInAdmin({ role: 'member' })).toBe(false);
  });
});

describe('SCIM tokens of non-owners', () => {
  const scimRole = () => roles.listRoles().find((r) => r.name === 'Scim holder') ?? roles.createRole({ name: 'Scim holder', rules: [rule('scim:manage')] }, fresh(owner.user.id));
  const managed = () => make('member', { provisionedBy: 'scim', externalId: `ext-w-${++n}` });

  it('a member’s token can’t make anyone editor of a team project', async () => {
    const team = projects.createTeamProject({ name: 'Wide Team', createdBy: owner.user.id });
    const holder = await make('member');
    roles.assignRole(holder.user.id, scimRole().id, fresh(owner.user.id));
    const target = await managed();
    asToken(fresh(holder.user.id), () => groups.createGroup({ displayName: 'Wide Team', members: [target.user.id] }));
    expect(store.membershipsOf(target.user.id).some((m) => m.projectId === team.id)).toBe(false);
    // The owner's token does.
    const other = await managed();
    asToken(fresh(owner.user.id), () => groups.createGroup({ displayName: 'Wide Team Owner', members: [other.user.id] }));
    process.env.LANDFLOW_SCIM_GROUP_MAP = 'Wide Team Two=project:Wide Team:editor';
    const third = await managed();
    asToken(fresh(owner.user.id), () => groups.createGroup({ displayName: 'Wide Team Two', members: [third.user.id] }));
    expect(store.membershipsOf(third.user.id).some((m) => m.projectId === team.id)).toBe(true);
    // A group delete by the member's token strips nothing it may not change.
    const gone = groups.listGroups().find((g) => g.displayName === 'Wide Team Two')!;
    asToken(fresh(holder.user.id), () => groups.deleteGroup(gone.id));
    expect(store.membershipsOf(third.user.id).some((m) => m.projectId === team.id)).toBe(true);
    delete process.env.LANDFLOW_SCIM_GROUP_MAP;
  });

  it('an admin’s token can’t promote to admin or demote; the owner’s can', async () => {
    process.env.LANDFLOW_SCIM_GROUP_MAP = 'Wide Admins=role:admin';
    const target = await managed();
    asToken(fresh(admin.user.id), () => groups.createGroup({ displayName: 'Wide Admins', members: [target.user.id] }));
    expect(fresh(target.user.id).role).toBe('member');
    const group = groups.listGroups().find((g) => g.displayName === 'Wide Admins')!;
    const second = await managed();
    asToken(fresh(owner.user.id), () => groups.changeGroup(group.id, { add: [second.user.id] }));
    expect(fresh(second.user.id).role).toBe('admin');
    delete process.env.LANDFLOW_SCIM_GROUP_MAP;
  });

  it('refuses accounts whose custom role holds what the token’s person couldn’t grant, and renames of accounts SCIM didn’t provision', async () => {
    const strong = roles.createRole({ name: 'Wide strong', rules: [rule('plugins:manage')] }, fresh(owner.user.id));
    const target = await managed();
    roles.assignRole(target.user.id, strong.id, fresh(owner.user.id));
    expect(() => asToken(fresh(admin.user.id), () => scimUsers.patchScimUser(target.user.id, { Operations: [{ op: 'replace', path: 'active', value: false }] }))).toThrow(/couldn’t grant/);
    const holder = await make('member');
    roles.assignRole(holder.user.id, scimRole().id, fresh(owner.user.id));
    const local = await make('member');
    expect(() => asToken(fresh(holder.user.id), () => scimUsers.patchScimUser(local.user.id, { Operations: [{ op: 'replace', path: 'userName', value: 'taken-over@example.test' }] }))).toThrow(/didn’t provision/);
    const provisioned = await managed();
    expect(asToken(fresh(holder.user.id), () => scimUsers.patchScimUser(provisioned.user.id, { Operations: [{ op: 'replace', path: 'userName', value: `renamed${n}@example.test` }] })).email).toBe(`renamed${n}@example.test`);
  });
});

describe('a user manager with a custom role', () => {
  const managerOf = async () => {
    const role = roles.listRoles().find((r) => r.name === 'People wide') ?? roles.createRole({ name: 'People wide', rules: [rule('users:manage')] }, fresh(owner.user.id));
    const manager = await make('member');
    roles.assignRole(manager.user.id, role.id, fresh(owner.user.id));
    return manager;
  };

  it('acts only on people within projects they administer', async () => {
    const manager = await managerOf();
    const team = projects.createTeamProject({ name: 'Elsewhere', createdBy: owner.user.id });
    const target = await make('member');
    store.setMember(team.id, target.user.id, 'editor');
    expect(userScope.mayActOnUser(fresh(manager.user.id), fresh(target.user.id))).toBe(false);
    store.setMember(team.id, manager.user.id, 'admin');
    expect(userScope.mayActOnUser(fresh(manager.user.id), fresh(target.user.id))).toBe(true);
    expect(userScope.mayActOnUser(fresh(admin.user.id), fresh(target.user.id))).toBe(true);
  });

  it('removes only with the things going to the owner or a project they administer', async () => {
    const manager = await managerOf();
    const team = projects.createTeamProject({ name: 'Mine to run', createdBy: owner.user.id });
    store.setMember(team.id, manager.user.id, 'admin');
    expect(userScope.mayTransferTo(fresh(manager.user.id), { projectId: team.id })).toBe(true);
    expect(userScope.mayTransferTo(fresh(manager.user.id), { userId: owner.user.id })).toBe(true);
    expect(userScope.mayTransferTo(fresh(manager.user.id), { userId: admin.user.id })).toBe(false);
    expect(userScope.mayTransferTo(fresh(manager.user.id), { projectId: projects.createTeamProject({ name: 'Not mine', createdBy: owner.user.id }).id })).toBe(false);
    const target = await make('member');
    const refused = await call(userRoute.DELETE, `/api/users/${target.user.id}`, { method: 'DELETE', session: manager.session, body: { transferTo: { userId: admin.user.id } } }, { id: target.user.id });
    expect(refused.status).toBe(403);
  });

  it('never gets a reset link back: it goes by email, and without email the request is refused', async () => {
    const manager = await managerOf();
    const target = await make('member');
    const asManager = await call(resetRoute.POST, `/api/users/${target.user.id}/password-reset`, { method: 'POST', session: manager.session }, { id: target.user.id });
    expect(asManager.body?.link).toBeUndefined();
    expect([409, 503]).toContain(asManager.status);
    const asAdmin = await call(resetRoute.POST, `/api/users/${target.user.id}/password-reset`, { method: 'POST', session: admin.session }, { id: target.user.id });
    if (asAdmin.status === 200) expect(asAdmin.body.link).toMatch(/reset-password/);
  });
});

describe('MCP grants re-check what they bind', () => {
  it('a non-admin can’t change or delete a grant whose stored credential they can’t use, nor bind one for others without share', async () => {
    const mcpRole = roles.createRole({ name: 'Mcp wide', rules: [rule('mcp:manage')] }, fresh(owner.user.id));
    const holder = await make('member');
    roles.assignRole(holder.user.id, mcpRole.id, fresh(owner.user.id));
    const secret = credentials.create({ name: 'Wide private', type: 'core.openAiApi', data: { apiKey: 'private-never-shown', baseUrl: 'http://localhost:1' } });
    projects.setHomeProject('credential', secret.id, `personal_${owner.user.id}`);
    const stored = grants.createGrant({ subject: { kind: 'role', id: 'member' }, pluginId: 'core', tools: '*', credentials: { 'core.openAiApi': secret.id } }, fresh(admin.user.id));
    expect(() => grants.updateGrant(stored.id, { tools: ['x'] }, fresh(holder.user.id))).toThrow(grants.McpGrantError);
    expect(() => grants.deleteGrant(stored.id, fresh(holder.user.id))).toThrow(grants.McpGrantError);
    expect(grants.deleteGrant(stored.id, fresh(admin.user.id))).toBe(true);
    // Their own credential, bound for the whole member role: needs the right to share it.
    const mine = credentials.create({ name: 'Wide mine', type: 'core.openAiApi', data: { apiKey: 'mine-never-shown', baseUrl: 'http://localhost:1' } });
    projects.setHomeProject('credential', mine.id, `personal_${holder.user.id}`);
    const forSelf = grants.createGrant({ subject: { kind: 'user', id: holder.user.id }, pluginId: 'core', tools: '*', credentials: { 'core.openAiApi': mine.id } }, fresh(holder.user.id));
    expect(forSelf.credentials['core.openAiApi']).toBe(mine.id);
    expect(() => grants.createGrant({ subject: { kind: 'user', id: admin.user.id }, pluginId: 'core', tools: '*', credentials: { 'core.openAiApi': mine.id } }, fresh(holder.user.id))).not.toThrow();
  });
});
