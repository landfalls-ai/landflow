/**
 * Custom instance roles (C32, docs/features/authentication.md#custom-roles): the shared rules (`can` with grants,
 * `ungrantable`), then the store (create, edit, delete, assign, audited with from/to, fail-closed), the user read that
 * carries the role, `isInstanceAdmin` and the audit read scope. The route and SCIM tests are in the sibling files.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-roles-'));
const ENV: Record<string, string> = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const shared = await import('@/lib/shared/auth');
const { can, ungrantable, ACTIONS, GRANTABLE_ACTIONS, OWNER_ONLY_GRANTS } = shared;
const { ACTION_LABELS } = await import('@/lib/shared/roles');
const auth = await import('@/lib/server/auth');
const roles = await import('@/lib/server/auth/roles');
const access = await import('@/lib/server/projects/access');
const auditAccess = await import('@/lib/server/audit/access');
const { queryEvents } = await import('@/lib/server/audit/store');
const projects = await import('@/lib/server/projects');
const { personalProjectId } = await import('@/lib/shared/projects');

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

describe('can() with grants', () => {
  it('a member with a grant may do exactly that action', () => {
    const holder = { role: 'member' as const, grants: ['plugins:manage' as const] };
    expect(can(holder, 'plugins:manage')).toBe(true);
    expect(can(holder, 'users:manage')).toBe(false);
  });

  it('reads the grants from a server user record too (customRole.actions)', () => {
    const holder = { role: 'member' as const, customRole: { actions: ['audit:read' as const] } };
    expect(can(holder, 'audit:read')).toBe(true);
    expect(can(holder, 'mcp:manage')).toBe(false);
  });

  it('without grants every built-in case is unchanged', () => {
    for (const action of ACTIONS) {
      expect(can({ role: 'owner' }, action)).toBe(true);
      expect(can({ role: 'admin' }, action)).toBe(true);
      expect(can({ role: 'member' }, action)).toBe(false);
    }
    expect(can(null, 'users:manage')).toBe(false);
  });

  it('lists the eleven actions; projects:manage is not grantable; users:manage and apiKeys:admin are the owner’s to grant', () => {
    expect(ACTIONS).toHaveLength(11);
    expect(GRANTABLE_ACTIONS).toHaveLength(10);
    expect(GRANTABLE_ACTIONS).not.toContain('projects:manage');
    expect([...OWNER_ONLY_GRANTS].sort()).toEqual(['apiKeys:admin', 'plugins:manage', 'scim:manage', 'settings:manage', 'users:manage']);
    for (const action of ACTIONS) expect(ACTION_LABELS[action].label.length).toBeGreaterThan(0);
  });
});

describe('ungrantable()', () => {
  const holder = { role: 'member' as const, grants: ['users:manage' as const, 'mcp:manage' as const] };
  it('a holder of users:manage and mcp:manage may not grant scim:manage (AS-2)', () => {
    expect(ungrantable(holder, ['scim:manage'])).toEqual(['scim:manage']);
    expect(ungrantable(holder, ['mcp:manage'])).toEqual([]);
  });
  it('an admin may not grant users:manage or apiKeys:admin, the owner may (AS-3)', () => {
    expect(ungrantable({ role: 'admin' }, ['users:manage', 'apiKeys:admin', 'mcp:manage'])).toEqual(['users:manage', 'apiKeys:admin']);
    expect(ungrantable({ role: 'owner' }, ['users:manage', 'apiKeys:admin'])).toEqual([]);
  });
  it('nobody may grant projects:manage', () => {
    expect(ungrantable({ role: 'owner' }, ['projects:manage'])).toEqual(['projects:manage']);
    expect(ungrantable({ role: 'admin' }, ['projects:manage'])).toEqual(['projects:manage']);
  });
  it('a holder with users:manage still can’t pass that on (owner only)', () => {
    expect(ungrantable({ role: 'member', grants: ['users:manage'] }, ['users:manage'])).toEqual(['users:manage']);
  });
});

describe('the store', () => {
  let owner: Awaited<ReturnType<typeof auth.createOwner>>;
  let admin: Awaited<ReturnType<typeof auth.createUser>>;
  let member: Awaited<ReturnType<typeof auth.createUser>>;
  let other: Awaited<ReturnType<typeof auth.createUser>>;

  beforeAll(async () => {
    auth.disableTestAuth();
    owner = await auth.createOwner({ email: 'owner@example.com', name: 'Olive', password: 'owner-password-1' });
    admin = await auth.createUser({ email: 'admin@example.com', name: 'Adam', role: 'admin', password: 'admin-password-1' });
    member = await auth.createUser({ email: 'member@example.com', name: 'Mia', role: 'member', password: 'member-password-1' });
    other = await auth.createUser({ email: 'other@example.com', name: 'Otto', role: 'member', password: 'other-password-1' });
  });
  afterAll(() => auth.enableTestAuth());

  it('creates, lists and audits a role with its rules', () => {
    const role = roles.createRole({ name: 'Platform', description: 'Plugins and MCP', rules: [{ action: 'plugins:manage', effect: 'allow' }, { action: 'mcp:manage', effect: 'allow' }] }, owner);
    expect(role.name).toBe('Platform');
    expect(role.holders).toBe(0);
    expect(roles.listRoles().map((r) => r.name)).toEqual(['Platform']);
    const events = queryEvents({ action: ['role.created'] }).events;
    expect(events).toHaveLength(1);
    expect(events[0].details).toMatchObject({ to: expect.stringContaining('plugins:manage') });
  });

  it('refuses a clashing name (case-insensitive), a reserved name and an unknown or ungrantable action', () => {
    expect(() => roles.createRole({ name: 'platform', rules: [{ action: 'mcp:manage', effect: 'allow' }] }, owner)).toThrow(/already/i);
    expect(() => roles.createRole({ name: 'Admin', rules: [{ action: 'mcp:manage', effect: 'allow' }] }, owner)).toThrow(/built-in role/i);
    expect(() => roles.createRole({ name: 'Everything', rules: [{ action: 'projects:manage', effect: 'allow' }] }, owner)).toThrow(/projects:manage/);
    expect(() => roles.createRole({ name: 'Boss', rules: [{ action: 'users:manage', effect: 'allow' }] }, admin)).toThrow(/Only the owner can grant users:manage/);
  });

  it('assigns a role to a member: getUser carries it, viewerOf the grants; isInstanceAdmin stays false', () => {
    const role = roles.listRoles()[0];
    const updated = roles.assignRole(member.id, role.id, owner);
    expect(updated.customRole).toMatchObject({ id: role.id, name: 'Platform' });
    const read = auth.getUser(member.id)!;
    expect(read.customRole?.actions.sort()).toEqual(['mcp:manage', 'plugins:manage']);
    expect(can(read, 'plugins:manage')).toBe(true);
    expect(can(read, 'users:manage')).toBe(false);
    const view = auth.viewerOf(read);
    expect(view.customRole).toEqual({ id: role.id, name: 'Platform' });
    expect(view.grants?.sort()).toEqual(['mcp:manage', 'plugins:manage']);
    expect(can(view, 'mcp:manage')).toBe(true);
    expect(access.isInstanceAdmin(read)).toBe(false);
    expect(roles.listRoles()[0].holders).toBe(1);
    const events = queryEvents({ action: ['user.custom_role'] }).events;
    expect(events[0].details).toMatchObject({ from: null, to: 'Platform' });
  });

  it('a holder of every grantable action is still not an instance admin', () => {
    const all = roles.createRole({ name: 'Almost', rules: GRANTABLE_ACTIONS.map((action) => ({ action, effect: 'allow' as const })) }, owner);
    roles.assignRole(other.id, all.id, owner);
    const read = auth.getUser(other.id)!;
    expect(access.isInstanceAdmin(read)).toBe(false);
    expect(access.projectRole(read, projects.createTeamProject({ name: 'Secret', createdBy: owner.id }).id)).toBeUndefined();
    roles.assignRole(other.id, null, owner);
  });

  it('refuses to assign to an admin or the owner, and an actor can’t assign more than they hold', async () => {
    const role = roles.listRoles()[0];
    expect(() => roles.assignRole(admin.id, role.id, owner)).toThrow(/member/i);
    expect(() => roles.assignRole(owner.id, role.id, owner)).toThrow(/can’t change/i);
    const lead = await auth.createUser({ email: 'lead@example.com', name: 'Lena', role: 'member', password: 'lead-password-1' });
    const leadRole = roles.createRole({ name: 'Lead', rules: [{ action: 'users:manage', effect: 'allow' }, { action: 'plugins:manage', effect: 'allow' }] }, owner);
    roles.assignRole(lead.id, leadRole.id, owner);
    const noUsers = roles.createRole({ name: 'Small', rules: [{ action: 'variables:manage', effect: 'allow' }] }, owner);
    // Lead manages users but doesn't hold variables:manage; and nobody but the owner passes users:manage on.
    expect(() => roles.assignRole(other.id, noUsers.id, auth.getUser(lead.id)!)).toThrow(/hold/i);
    expect(() => roles.assignRole(other.id, leadRole.id, auth.getUser(lead.id)!)).toThrow(/Only the owner can grant users:manage/);
    expect(() => roles.assignRole(other.id, leadRole.id, admin)).toThrow(/Only the owner can grant users:manage/);
    roles.deleteRole(noUsers.id, owner, { confirm: true });
    roles.deleteRole(leadRole.id, owner, { confirm: true });
  });

  it('editing a role changes the holder’s next read, with from and to in the event (FR-5)', () => {
    const role = roles.listRoles().find((r) => r.name === 'Platform')!;
    roles.updateRole(role.id, { rules: [{ action: 'plugins:manage', effect: 'allow' }] }, owner);
    expect(can(auth.getUser(member.id), 'mcp:manage')).toBe(false);
    expect(can(auth.getUser(member.id), 'plugins:manage')).toBe(true);
    const events = queryEvents({ action: ['role.updated'] }).events;
    expect(events[0].details).toMatchObject({ from: expect.stringContaining('mcp:manage'), to: 'plugins:manage' });
  });

  it('promoting a holder to admin clears the role (D7)', () => {
    const role = roles.listRoles().find((r) => r.name === 'Platform')!;
    roles.assignRole(other.id, role.id, owner);
    auth.updateUser(other.id, { role: 'admin' });
    expect(auth.getUser(other.id)!.customRole).toBeUndefined();
    auth.updateUser(other.id, { role: 'member' });
  });

  it('gives a holder of audit:read the events of their member projects only; an admin every event (D9, AS-6)', () => {
    const auditor = roles.createRole({ name: 'Auditor', rules: [{ action: 'audit:read', effect: 'allow' }] }, owner);
    roles.assignRole(other.id, auditor.id, owner);
    const holder = auth.getUser(other.id)!;
    const team = projects.createTeamProject({ name: 'Auditors project', createdBy: owner.id });
    projects.setMember(team.id, other.id, 'viewer');
    const mine = auditAccess.auditFiltersFor(holder, {});
    expect(mine.ok && mine.filters.projectIds).toEqual(expect.arrayContaining([personalProjectId(other.id), team.id]));
    const outsider = projects.createTeamProject({ name: 'Not theirs', createdBy: owner.id });
    expect(auditAccess.auditFiltersFor(holder, { projectId: outsider.id }).ok).toBe(false);
    const everything = auditAccess.auditFiltersFor(admin, {});
    expect(everything.ok && everything.filters.projectIds).toBeUndefined();
  });

  it('deleting a role in use asks to confirm; then holders become plain members, audited per holder', () => {
    const role = roles.listRoles().find((r) => r.name === 'Platform')!;
    expect(() => roles.deleteRole(role.id, owner, { confirm: false })).toThrow(expect.objectContaining({ status: 409 }));
    roles.deleteRole(role.id, owner, { confirm: true });
    expect(auth.getUser(member.id)!.customRole).toBeUndefined();
    expect(can(auth.getUser(member.id), 'plugins:manage')).toBe(false);
    expect(queryEvents({ action: ['role.deleted'] }).events.some((e) => e.target?.name === 'Platform')).toBe(true);
    expect(queryEvents({ action: ['user.custom_role'] }).events.some((e) => e.details?.reason === 'role_deleted' && e.target?.id === member.id)).toBe(true);
  });

  it('with audit fail-closed and the store down nothing is written (AS-7)', async () => {
    const { database } = await import('@/lib/server/db');
    const db = database();
    const real = db.insertNew.bind(db);
    const broken = vi.spyOn(db, 'insertNew').mockImplementation(((table: string, row: unknown) => {
      if (table === 'audit_events') throw new Error('database or disk is full');
      return real(table as never, row as never);
    }) as never);
    process.env.LANDFLOW_AUDIT_FAIL_CLOSED = 'true';
    try {
      expect(() => roles.createRole({ name: 'Ghost', rules: [{ action: 'mcp:manage', effect: 'allow' }] }, owner)).toThrow(expect.objectContaining({ status: 503 }));
    } finally {
      broken.mockRestore();
      delete process.env.LANDFLOW_AUDIT_FAIL_CLOSED;
    }
    expect(roles.roleByName('Ghost')).toBeUndefined();
  });
});
