/**
 * Custom roles, the escalation review (C32, 2026-11-23): scim:manage, plugins:manage and settings:manage are the owner's
 * to grant; SCIM never changes the owner and never grants more than its token's person could; MCP grants bind only
 * credentials their author may use; routes that reach every project need the built-in admin role; a user manager can't
 * act on someone holding more than they hold; role names are plain; deleting a role is checked like making one.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-roles-esc-'));
const ENV: Record<string, string> = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const UNSET = ['LANDFLOW_OWNER_EMAIL', 'LANDFLOW_OWNER_PASSWORD', 'LANDFLOW_SCIM_GROUP_MAP'];
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
for (const key of UNSET) delete process.env[key];

const shared = await import('@/lib/shared/auth');
const auth = await import('@/lib/server/auth');
const roles = await import('@/lib/server/auth/roles');
const groups = await import('@/lib/server/scim/groups');
const scimUsers = await import('@/lib/server/scim/users');
const grants = await import('@/lib/server/mcp/grants');
const approvals = await import('@/lib/server/governance/approvals');
const projects = await import('@/lib/server/projects');
const { credentials } = await import('@/lib/server/credentials/vault');
const { routePolicy } = await import('@/lib/server/auth/policy');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
registry.registerBuiltin(corePlugin);

afterAll(() => {
  auth.enableTestAuth();
  for (const key of [...Object.keys(ENV), ...UNSET]) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

let owner: Awaited<ReturnType<typeof auth.createOwner>>;
let admin: Awaited<ReturnType<typeof auth.createUser>>;
let n = 0;
const member = () => auth.createUser({ email: `m${++n}@example.test`, name: `M${n}`, role: 'member', password: 'member-password-1' });
const managed = () => auth.createUser({ email: `x${++n}@example.test`, name: `X${n}`, role: 'member', provisionedBy: 'scim', externalId: `ext-esc-${n}` });
const fresh = (id: string) => auth.getUser(id)!;
const principalOf = (user: ReturnType<typeof fresh>) => ({ user, via: 'api-key' as const, apiKey: { id: 'key_x', scopes: ['scim' as const] } });
const asToken = <T>(user: ReturnType<typeof fresh>, fn: () => T): T => auth.withAuth({ principal: principalOf(user) }, fn);
const rule = (action: string) => ({ action, effect: 'allow' as const });

beforeAll(async () => {
  auth.disableTestAuth();
  owner = await auth.createOwner({ email: 'owner@example.test', name: 'Olive', password: 'owner-password-1' });
  admin = await auth.createUser({ email: 'admin@example.test', name: 'Ada', role: 'admin', password: 'admin-password-1' });
});

describe('owner-only grants', () => {
  it('names scim:manage, plugins:manage and settings:manage with users:manage and apiKeys:admin', () => {
    expect([...shared.OWNER_ONLY_GRANTS].sort()).toEqual(['apiKeys:admin', 'plugins:manage', 'scim:manage', 'settings:manage', 'users:manage']);
  });

  it('an admin can’t put any of them in a role; the owner can', () => {
    for (const action of ['scim:manage', 'plugins:manage', 'settings:manage']) {
      expect(() => roles.createRole({ name: `Try ${action}`, rules: [rule(action)] }, admin)).toThrow(/Only the owner can grant/);
    }
    expect(roles.createRole({ name: 'Owner made', rules: [rule('plugins:manage'), rule('settings:manage'), rule('scim:manage')] }, owner).rules).toHaveLength(3);
  });
});

describe('SCIM', () => {
  const patchActive = { Operations: [{ op: 'replace', path: 'active', value: false }] };

  it('can’t change the owner’s account: not userName, emails, active, externalId or delete', () => {
    expect(() => scimUsers.patchScimUser(owner.id, patchActive)).toThrow(/owner/);
    expect(() => scimUsers.patchScimUser(owner.id, { Operations: [{ op: 'replace', path: 'userName', value: 'evil@example.test' }] })).toThrow(/owner/);
    expect(() => scimUsers.patchScimUser(owner.id, { Operations: [{ op: 'replace', path: 'externalId', value: 'x' }] })).toThrow(/owner/);
    expect(() => scimUsers.replaceScimUser(owner.id, { userName: 'evil@example.test' })).toThrow(/owner/);
    expect(() => scimUsers.deleteScimUser(owner.id)).toThrow(/owner/);
    expect(fresh(owner.id).email).toBe('owner@example.test');
    expect(fresh(owner.id).disabledAt).toBeUndefined();
  });

  it('a token can’t grant a role its person couldn’t: an admin’s token leaves the owner-made role ungiven', async () => {
    process.env.LANDFLOW_SCIM_GROUP_MAP = 'Platform Team=role:custom:Owner made';
    const user = await managed();
    asToken(admin, () => groups.createGroup({ displayName: 'Platform Team', members: [user.id] }));
    expect(fresh(user.id).customRole).toBeUndefined();
  });

  it('the owner’s token does give it', async () => {
    process.env.LANDFLOW_SCIM_GROUP_MAP = 'Owner Team=role:custom:Owner made';
    const user = await managed();
    asToken(owner, () => groups.createGroup({ displayName: 'Owner Team', members: [user.id] }));
    expect(fresh(user.id).customRole?.name).toBe('Owner made');
  });

  it('a member’s SCIM token can’t make itself or anyone an admin', async () => {
    const holder = await member();
    const scimRole = roles.createRole({ name: 'Scim holder', rules: [rule('scim:manage')] }, owner);
    roles.assignRole(holder.id, scimRole.id, owner);
    process.env.LANDFLOW_SCIM_GROUP_MAP = 'Landflow Admins=role:admin';
    const target = await managed();
    asToken(fresh(holder.id), () => groups.createGroup({ displayName: 'Landflow Admins', members: [target.id] }));
    expect(fresh(target.id).role).toBe('member');
    expect(() => asToken(fresh(holder.id), () => scimUsers.patchScimUser(holder.id, patchActive))).toThrow();
  });
});

describe('MCP grants and credentials', () => {
  it('a manager with a custom role can’t bind a credential they can’t use; an admin can', async () => {
    const holder = await member();
    const mcpRole = roles.createRole({ name: 'Mcp only', rules: [rule('mcp:manage')] }, owner);
    roles.assignRole(holder.id, mcpRole.id, owner);
    const secret = credentials.create({ name: 'Owner private', type: 'core.openAiApi', data: { apiKey: 'private-never-shown', baseUrl: 'http://localhost:1' } });
    projects.setHomeProject('credential', secret.id, `personal_${owner.id}`);
    const input = { subject: { kind: 'role' as const, id: 'member' }, pluginId: 'core', tools: '*' as const, credentials: { 'core.openAiApi': secret.id } };
    expect(() => grants.createGrant(input, fresh(holder.id))).toThrow(grants.McpGrantError);
    const ok = grants.createGrant({ ...input, credentials: {} }, fresh(holder.id));
    expect(() => grants.updateGrant(ok.id, { credentials: input.credentials }, fresh(holder.id))).toThrow(grants.McpGrantError);
    expect(grants.createGrant(input, admin).credentials).toEqual(input.credentials);
  });
});

describe('settings:manage does not reach every project', () => {
  const holder = { id: 'u_holder', role: 'member' as const, customRole: { actions: ['settings:manage' as const] } };

  it('a holder is not a four-eyes or promotion approver', () => {
    const { updateGovernancePolicy } = require_policy();
    updateGovernancePolicy({ fourEyes: { enabled: true, approverRole: 'admin', unpublish: false, notifyEmail: false, channelIds: [] } });
    try {
      expect(approvals.mayApprove(holder as never, 'wf_any', 'someone-else')).toBe(false);
      expect(approvals.mayApprove({ id: 'u_admin2', role: 'admin' }, 'wf_any', 'someone-else')).toBe(true);
    } finally {
      updateGovernancePolicy({ fourEyes: { enabled: false } });
    }
  });

  it('sync, source control and the other instance-wide writes need the built-in admin role', () => {
    for (const [method, path] of [['POST', '/api/sync/apply'], ['POST', '/api/source-control/push'], ['POST', '/api/source-control/pull'], ['POST', '/api/executions/stop-all']] as const) {
      expect(routePolicy(method, path), path).toMatchObject({ instanceAdmin: true });
    }
    expect(routePolicy('GET', '/api/sync/export').instanceAdmin).toBeUndefined();
  });
});

function require_policy() {
  return policyModule;
}
const policyModule = await import('@/lib/server/governance/policy');

describe('acting on someone who holds more', () => {
  it('a user manager can’t reset, remove or MFA-reset a member whose role holds actions they lack', async () => {
    const manager = await member();
    const usersRole = roles.createRole({ name: 'People', rules: [rule('users:manage')] }, owner);
    roles.assignRole(manager.id, usersRole.id, owner);
    const strong = await member();
    const mcpRole = roles.listRoles().find((r) => r.name === 'Mcp only')!;
    roles.assignRole(strong.id, mcpRole.id, owner);
    const plain = await member();
    const actor = fresh(manager.id);
    expect(shared.canManageUser(actor, fresh(strong.id), { kind: 'reset-password' })).toBe(false);
    expect(shared.canManageUser(actor, fresh(strong.id), { kind: 'remove' })).toBe(false);
    expect(shared.canResetMfa(actor, fresh(strong.id))).toBe(false);
    expect(shared.canManageUser(actor, fresh(plain.id), { kind: 'reset-password' })).toBe(true);
    expect(shared.canResetMfa(actor, fresh(plain.id))).toBe(true);
    // An admin may act on a member holding what the admin could grant, not on one holding owner-only actions.
    const ownerMade = roles.listRoles().find((r) => r.name === 'Owner made')!;
    const powerful = await member();
    roles.assignRole(powerful.id, ownerMade.id, owner);
    expect(shared.canManageUser(admin, fresh(powerful.id), { kind: 'reset-password' })).toBe(false);
    expect(shared.canResetMfa(admin, fresh(powerful.id))).toBe(false);
    expect(shared.canResetMfa(owner, fresh(powerful.id))).toBe(true);
    expect(shared.canResetMfa(admin, fresh(plain.id))).toBe(true);
    // Admins' second factors are the owner's to reset.
    expect(shared.canResetMfa(admin, { id: 'other_admin', role: 'admin' })).toBe(false);
  });
});

describe('role names and deleting', () => {
  it('a name is letters, digits, space, - and _; look-alikes of a built-in name are refused', () => {
    for (const name of ['Ops!', 'a/b', '<b>x</b>', 'ＡＤＭＩＮ', 'Ａdmin', 'ｍember']) {
      expect(() => roles.createRole({ name, rules: [rule('audit:read')] }, owner), name).toThrow(/letters|built-in/);
    }
    expect(roles.createRole({ name: 'Ops team_2-b', rules: [rule('audit:read')] }, owner).name).toBe('Ops team_2-b');
  });

  it('an admin can’t delete a role that holds what they couldn’t grant', () => {
    const ownerMade = roles.listRoles().find((r) => r.name === 'Owner made')!;
    expect(() => roles.deleteRole(ownerMade.id, admin, { confirm: true })).toThrow(/Only the owner can grant/);
    expect(roles.listRoles().some((r) => r.id === ownerMade.id)).toBe(true);
  });
});
