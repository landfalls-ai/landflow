/**
 * SCIM groups mapped to custom roles (C32 AS-8): `LANDFLOW_SCIM_GROUP_MAP="Platform Team=role:custom:Platform"` parses; a
 * push into the group gives the managed member the role and a removal takes it away; with two groups mapping two roles the
 * group first by name wins (C32-D4); a name with no role is ignored and described as an unknown role; an admin never
 * holds one; a role given by hand that the map doesn't name is left alone.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-roles-scim-'));
const ENV: Record<string, string> = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const UNSET = ['LANDFLOW_OWNER_EMAIL', 'LANDFLOW_OWNER_PASSWORD', 'LANDFLOW_SCIM_GROUP_MAP'];
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
for (const key of UNSET) delete process.env[key];

const auth = await import('@/lib/server/auth');
const roles = await import('@/lib/server/auth/roles');
const groups = await import('@/lib/server/scim/groups');
const { queryEvents } = await import('@/lib/server/audit/store');
const { can } = await import('@/lib/shared/auth');

afterAll(() => {
  auth.enableTestAuth();
  for (const key of [...Object.keys(ENV), ...UNSET]) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

let owner: Awaited<ReturnType<typeof auth.createOwner>>;
let n = 0;
const managed = (role: 'member' | 'admin' = 'member') => auth.createUser({ email: `s${++n}@example.test`, name: `S${n}`, role, provisionedBy: 'scim', externalId: `ext-${n}` });

beforeAll(async () => {
  auth.disableTestAuth();
  owner = await auth.createOwner({ email: 'owner@example.test', name: 'Olive', password: 'owner-password-1' });
  roles.createRole({ name: 'Platform', rules: [{ action: 'plugins:manage', effect: 'allow' }] }, owner);
  roles.createRole({ name: 'Auditor', rules: [{ action: 'audit:read', effect: 'allow' }] }, owner);
});

describe('the map', () => {
  it('parses role:custom:<name> and keeps the case of the name', () => {
    expect(groups.scimGroupMap('Platform Team=role:custom:Platform, Admins=role:admin,Other = role: custom: My Role')).toEqual({
      'Platform Team': { customRole: 'Platform' },
      Admins: { role: 'admin' },
      Other: { customRole: 'My Role' },
    });
  });

  it('describes it, and marks a name with no role as unknown', () => {
    const map = groups.scimGroupMap('A=role:custom:platform,B=role:custom:Ghosts');
    expect(groups.describeGroupMap(map)).toEqual({ A: 'role:custom:platform', B: 'role:custom:Ghosts (unknown role)' });
  });
});

describe('recomputeGrants', () => {
  it('AS-8: pushing a managed member into the group gives the role, removing them takes it away', () => {
    process.env.LANDFLOW_SCIM_GROUP_MAP = 'Platform Team=role:custom:Platform';
    return managed().then((user) => {
      const group = groups.createGroup({ displayName: 'Platform Team', members: [user.id] });
      expect(auth.getUser(user.id)!.customRole?.name).toBe('Platform');
      expect(can(auth.getUser(user.id), 'plugins:manage')).toBe(true);
      expect(queryEvents({ action: ['user.custom_role'] }).events.some((e) => e.target?.id === user.id && e.details?.to === 'Platform')).toBe(true);
      groups.changeGroup(group.id, { remove: [user.id] });
      expect(auth.getUser(user.id)!.customRole).toBeUndefined();
      groups.deleteGroup(group.id);
    });
  });

  it('two groups, two roles: the group first by name wins', async () => {
    process.env.LANDFLOW_SCIM_GROUP_MAP = 'Zeta=role:custom:Auditor,Alpha=role:custom:Platform';
    const user = await managed();
    groups.createGroup({ displayName: 'Zeta', members: [user.id] });
    groups.createGroup({ displayName: 'Alpha', members: [user.id] });
    expect(auth.getUser(user.id)!.customRole?.name).toBe('Platform');
  });

  it('a name with no role is ignored', async () => {
    process.env.LANDFLOW_SCIM_GROUP_MAP = 'Ghost Team=role:custom:Nobody';
    const user = await managed();
    groups.createGroup({ displayName: 'Ghost Team', members: [user.id] });
    expect(auth.getUser(user.id)!.customRole).toBeUndefined();
  });

  it('an admin never holds one; a user the identity provider does not manage is left alone; a role the map does not name stays', async () => {
    process.env.LANDFLOW_SCIM_GROUP_MAP = 'Platform Two=role:custom:Platform,Landflow Admins=role:admin';
    const admin = await managed();
    groups.createGroup({ displayName: 'Landflow Admins', members: [admin.id] });
    groups.createGroup({ displayName: 'Platform Two', members: [admin.id] });
    expect(auth.getUser(admin.id)!.role).toBe('admin');
    expect(auth.getUser(admin.id)!.customRole).toBeUndefined();
    const local = await auth.createUser({ email: 'local@example.test', name: 'Local', role: 'member', password: 'local-password-1' });
    groups.createGroup({ displayName: 'Local Group', members: [local.id] });
    const byHand = roles.listRoles().find((r) => r.name === 'Auditor')!;
    roles.assignRole(local.id, byHand.id, owner);
    groups.changeGroup(groups.listGroups().find((g) => g.displayName === 'Platform Two')!.id, { add: [local.id] });
    expect(auth.getUser(local.id)!.customRole?.name).not.toBe('Platform'); // not managed by SCIM
    const mem = await managed();
    roles.assignRole(mem.id, byHand.id, owner);
    const g = groups.createGroup({ displayName: 'Platform Three', members: [mem.id] });
    groups.changeGroup(g.id, { remove: [mem.id] });
    expect(auth.getUser(mem.id)!.customRole?.name).toBe('Auditor'); // Auditor isn't named by the map: it stays
  });
});
