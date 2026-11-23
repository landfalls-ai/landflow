/**
 * SCIM groups (`scim_groups`, `scim_group_members`, migration 801) and what they grant. Groups are only a source of
 * access: through LANDFLOW_SCIM_GROUP_MAP a group maps to an instance role or a team project membership, e.g.
 *
 *   LANDFLOW_SCIM_GROUP_MAP="Landflow Admins=role:admin,Data Team=project:Data:editor,Ops=project:prj_abc:viewer"
 *
 * - `role:admin` / `role:member` sets the instance role of users the identity provider manages (provisioned by SCIM
 *   or linked to it with an `externalId`): admin while they are in an admin group, member otherwise. Only when the
 *   map has a `role:` entry; the owner's role never changes.
 * - `role:custom:<name>` (C32) gives members of the group the custom role of that name (a custom role grants a subset of
 *   the admin actions, docs/features/authentication.md#custom-roles), for the same managed users and only while they are
 *   members: a person in several such groups gets the one whose group comes first by name; a name with no role is
 *   ignored (Settings → Security lists it as unknown); a role the map doesn't name, given by hand, is left alone.
 * - `project:<project id or team project name>[:role]` (role defaults to editor) makes members of the group members
 *   of the project, managed by SCIM (`source = 'scim'`), so leaving the group removes the membership. A team project
 *   named in the map that doesn't exist yet is created.
 * - A group the map doesn't name, with the same name as a team project, maps to that project as editor.
 *
 * A user's grants are worked out again whenever their groups change (members added or removed, a group renamed or
 * deleted), in the same transaction as the change.
 */
import { nanoid } from 'nanoid';
import type { ProjectRole } from '../../shared/projects';
import { auditedTransaction } from '../audit';
import { currentActorId } from '../auth/context';
import { authDb } from '../auth/db';
import { roleByName, setCustomRole } from '../auth/roles';
import { ungrantable } from '../../shared/auth';
import { projectRole } from '../projects/access';
import { getUser, updateUser } from '../auth/users';
import { recordAudit } from '../audit';
import { describeProjectMap, grantsFor, parseProjectMap, syncManagedMemberships, type ProjectGrant } from '../projects/mapping';
import { findProject } from '../projects/store';
import { changeRefusal, isAdminActor, scimActor } from './guard';
import { auditGroupChange, auditGroupCreated, auditGroupRemoved, auditUserChange } from './audit';
import { ScimError } from './http';

export interface ScimGroup {
  id: string;
  displayName: string;
  externalId?: string;
  createdAt: string;
  updatedAt: string;
}

interface GroupRow {
  id: string;
  display_name: string;
  external_id: string | null;
  created_at: string;
  updated_at: string;
}

const db = () => authDb();

const fromRow = (row: GroupRow): ScimGroup => ({
  id: row.id,
  displayName: row.display_name,
  ...(row.external_id && { externalId: row.external_id }),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toRow = (group: ScimGroup) => ({
  id: group.id,
  display_name: group.displayName,
  external_id: group.externalId ?? null,
  created_at: group.createdAt,
  updated_at: group.updatedAt,
});

// ---- the map ----------------------------------------------------------------------------------------------

export interface GroupMapping {
  role?: 'admin' | 'member';
  /** A custom role's name (`role:custom:<name>`, C32). */
  customRole?: string;
  project?: ProjectGrant;
}

/** LANDFLOW_SCIM_GROUP_MAP parsed: group name → instance role or project grant. */
export function scimGroupMap(text = process.env.LANDFLOW_SCIM_GROUP_MAP): Record<string, GroupMapping> {
  const map: Record<string, GroupMapping> = {};
  for (const entry of (text ?? '').split(',')) {
    const index = entry.indexOf('=');
    if (index <= 0) continue;
    const group = entry.slice(0, index).trim();
    const target = entry.slice(index + 1).trim();
    const role = /^role:\s*(admin|member)$/i.exec(target)?.[1]?.toLowerCase() as GroupMapping['role'];
    const customRole = /^role:\s*custom:\s*(.+)$/i.exec(target)?.[1]?.trim();
    if (group && role) map[group] = { role };
    else if (group && customRole) map[group] = { customRole };
    else if (group && /^project:/i.test(target)) {
      const grant = parseProjectMap(`${group}=${target.slice('project:'.length)}`)[group];
      if (grant) map[group] = { project: grant };
    }
  }
  return map;
}

/**
 * The map for Settings → Security: `{ group: "role:admin" | "role:custom:Platform" | "project:Data:editor" }`. A custom
 * role that doesn't exist is marked "(unknown role)"; of several groups mapping different roles, the ones that lose to
 * the group first by name say so.
 */
export function describeGroupMap(map = scimGroupMap()): Record<string, string> {
  const winner = Object.keys(map)
    .filter((group) => map[group].customRole)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))[0];
  return Object.fromEntries(
    Object.entries(map).map(([group, mapping]) => {
      if (mapping.customRole) {
        const known = roleByName(mapping.customRole);
        const loses = winner && group !== winner && map[winner].customRole?.toLowerCase() !== mapping.customRole.toLowerCase();
        return [group, `role:custom:${mapping.customRole}${known ? '' : ' (unknown role)'}${known && loses ? ` (loses to ${winner} for people in both)` : ''}`];
      }
      return [group, mapping.role ? `role:${mapping.role}` : `project:${describeProjectMap({ group: mapping.project! }).group}`];
    }),
  );
}

// ---- groups -----------------------------------------------------------------------------------------------

export function listGroups(): ScimGroup[] {
  return db()
    .all<GroupRow>('SELECT * FROM scim_groups ORDER BY created_at, id')
    .map(fromRow);
}

export function getGroup(id: string): ScimGroup | undefined {
  const row = db().get<GroupRow>('SELECT * FROM scim_groups WHERE id = ?', id);
  return row && fromRow(row);
}

export function countGroups(): number {
  return Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM scim_groups')?.n ?? 0);
}

function nameTaken(displayName: string, exceptId?: string): boolean {
  const row = db().get<{ id: string }>('SELECT id FROM scim_groups WHERE LOWER(display_name) = ?', displayName.trim().toLowerCase());
  return Boolean(row && row.id !== exceptId);
}

export function groupMembers(groupId: string): string[] {
  return db()
    .all<{ user_id: string }>('SELECT user_id FROM scim_group_members WHERE group_id = ? ORDER BY user_id', groupId)
    .map((row) => row.user_id);
}

/** The groups a user is in. */
export function groupsOf(userId: string): ScimGroup[] {
  return db()
    .all<GroupRow>('SELECT g.* FROM scim_groups g JOIN scim_group_members m ON m.group_id = g.id WHERE m.user_id = ? ORDER BY g.display_name', userId)
    .map(fromRow);
}

/** Known user ids only (members that aren't Landflow users are skipped). */
function knownUsers(ids: Iterable<string>): string[] {
  return [...new Set(ids)].filter((id) => getUser(id));
}

/** Work out `userIds`' grants again (see the module comment). */
export function recomputeGrants(userIds: Iterable<string>) {
  const map = scimGroupMap();
  const byName = new Map(Object.entries(map).map(([group, mapping]) => [group.toLowerCase(), mapping]));
  const managesRoles = Object.values(map).some((mapping) => mapping.role);
  const namedCustom = new Set(Object.values(map).flatMap((mapping) => (mapping.customRole ? [mapping.customRole.toLowerCase()] : [])));
  // The token's person (none outside a SCIM request: the map in the environment is the operator's own).
  const actor = scimActor();
  // Built-in roles (to or from admin) change only on the owner's token (or the operator's, with no token); a non-admin token touches only projects its person administers.
  const mayChangeRoles = !actor || actor.role === 'owner';
  const mayChangeProject = (projectId: string) => isAdminActor(actor) || projectRole(actor, projectId) === 'admin';
  for (const userId of new Set(userIds)) {
    const user = getUser(userId);
    if (!user) continue;
    // Never the token's own person, nor anyone SCIM may not change through /Users (the owner, an admin on a non-owner token, a role it couldn't grant).
    if (actor && changeRefusal(actor, user)) continue;
    const projectMap: Record<string, ProjectGrant> = {};
    let role: 'admin' | 'member' | undefined;
    // C32-D4: the group first by name wins when several map different custom roles.
    let customRole: ReturnType<typeof roleByName>;
    for (const group of groupsOf(userId).sort((x, y) => x.displayName.toLowerCase().localeCompare(y.displayName.toLowerCase()))) {
      const mapping = byName.get(group.displayName.toLowerCase());
      if (mapping?.customRole && !customRole) customRole = roleByName(mapping.customRole);
      if (mapping?.role) role = role === 'admin' || mapping.role === 'admin' ? 'admin' : 'member';
      if (mapping?.project) projectMap[group.displayName] = mapping.project;
      else if (!mapping) {
        const team = findProject(group.displayName);
        if (team?.type === 'team' && team.name.toLowerCase() === group.displayName.toLowerCase()) projectMap[group.displayName] = { project: team.id, role: 'editor' as ProjectRole };
      }
    }
    syncManagedMemberships(userId, 'scim', grantsFor(Object.keys(projectMap), projectMap, { create: isAdminActor(actor), createdBy: currentActorId() }), mayChangeProject);
    const managed = user.externalId || user.provisionedBy === 'scim';
    // A token never gives more than its person could: only the owner's changes a built-in role.
    if (managesRoles && managed && user.role !== 'owner' && mayChangeRoles) {
      const desired = role ?? 'member';
      if (user.role !== desired) auditUserChange(user, updateUser(userId, { role: desired }));
    }
    // ...and never a custom role holding what its person couldn't grant (the owner's token may give any).
    const refused = Boolean(actor && customRole && ungrantable(actor, customRole.rules.map((rule) => rule.action)).length);
    if (namedCustom.size && managed && user.role !== 'owner' && !refused) {
      const current = getUser(userId)!;
      const held = current.customRole;
      // Only members hold one; a role the map doesn't name (given by hand) stays.
      const desired = current.role === 'member' ? customRole : undefined;
      if (desired && desired.id !== held?.id) {
        setCustomRole(userId, desired.id);
        auditCustomRole(current, held?.name, desired.name);
      } else if (!desired && held && namedCustom.has(held.name.toLowerCase())) {
        setCustomRole(userId, null);
        auditCustomRole(current, held.name, undefined);
      }
    }
  }
}

function auditCustomRole(user: { id: string; email: string }, from: string | undefined, to: string | undefined) {
  recordAudit({
    action: 'user.custom_role',
    target: { type: 'user', id: user.id, name: user.email },
    summary: to ? `Gave ${user.email} the custom role ${to} through their SCIM groups` : `Took the custom role ${from ?? ''} from ${user.email} (no SCIM group maps it any more)`.replace('  ', ' '),
    details: { from: from ?? null, to: to ?? null, reason: 'scim' },
  });
}

/** Create a group with members. 409 when the name is taken. */
export function createGroup(input: { displayName: string; externalId?: string; members?: string[] }): ScimGroup {
  const displayName = input.displayName.trim();
  if (!displayName) throw new ScimError(400, 'displayName is required', 'invalidValue');
  const database = db();
  const [group, members] = auditedTransaction((): [ScimGroup, string[]] => {
    if (nameTaken(displayName)) throw new ScimError(409, `A group named “${displayName}” already exists`, 'uniqueness');
    const now = new Date().toISOString();
    const group: ScimGroup = { id: `grp_${nanoid(12)}`, displayName: displayName.slice(0, 200), ...(input.externalId && { externalId: input.externalId }), createdAt: now, updatedAt: now };
    database.insertNew('scim_groups', toRow(group));
    const members = knownUsers(input.members ?? []);
    for (const userId of members) database.insertNew('scim_group_members', { group_id: group.id, user_id: userId });
    recomputeGrants(members);
    auditGroupCreated(group, members);
    return [group, members];
  });
  return group;
}

export interface GroupChange {
  displayName?: string;
  externalId?: string | null;
  /** Replace the members. */
  members?: string[];
  add?: string[];
  remove?: string[];
}

/** Change a group (name, external id, members) and recompute the grants of everyone it affects, in one transaction. */
export function changeGroup(id: string, change: GroupChange): ScimGroup {
  const database = db();
  const next = auditedTransaction((): ScimGroup => {
    const group = getGroup(id);
    if (!group) throw new ScimError(404, `Group ${id} not found`);
    const affected = new Set<string>();
    const next: ScimGroup = { ...group, updatedAt: new Date().toISOString() };
    if (change.displayName !== undefined) {
      const displayName = change.displayName.trim();
      if (!displayName) throw new ScimError(400, 'displayName can’t be empty', 'invalidValue');
      if (nameTaken(displayName, id)) throw new ScimError(409, `A group named “${displayName}” already exists`, 'uniqueness');
      if (displayName !== group.displayName) for (const userId of groupMembers(id)) affected.add(userId);
      next.displayName = displayName.slice(0, 200);
    }
    if (change.externalId !== undefined) {
      if (change.externalId) next.externalId = change.externalId;
      else delete next.externalId;
    }
    database.upsert('scim_groups', toRow(next));
    const current = new Set(groupMembers(id));
    let wanted = new Set(current);
    if (change.members) wanted = new Set(knownUsers(change.members));
    for (const userId of knownUsers(change.add ?? [])) wanted.add(userId);
    for (const userId of change.remove ?? []) wanted.delete(userId);
    const removed: string[] = [];
    const added: string[] = [];
    for (const userId of current) {
      if (wanted.has(userId)) continue;
      database.delete('scim_group_members', { group_id: id, user_id: userId });
      affected.add(userId);
      removed.push(userId);
    }
    for (const userId of wanted) {
      if (current.has(userId)) continue;
      database.insertNew('scim_group_members', { group_id: id, user_id: userId });
      affected.add(userId);
      added.push(userId);
    }
    recomputeGrants(affected);
    // Inside the transaction: the audit insert uses the same database, so a rolled-back change leaves no event and,
    // with LANDFLOW_AUDIT_FAIL_CLOSED, an event that can't be stored rolls the change back.
    auditGroupChange(group, next, added, removed);
    return next;
  });
  return next;
}

/** Delete a group; its members lose what it granted. */
export function deleteGroup(id: string): boolean {
  const database = db();
  const removed = auditedTransaction(() => {
    const group = getGroup(id);
    if (!group) return undefined;
    const members = groupMembers(id);
    for (const userId of members) database.delete('scim_group_members', { group_id: id, user_id: userId });
    database.delete('scim_groups', { id });
    recomputeGrants(members);
    auditGroupRemoved(group, members);
    return { group, members };
  });
  return Boolean(removed);
}
