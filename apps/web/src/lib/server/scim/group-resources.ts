/**
 * SCIM Groups (RFC 7643 §4.2) over ./groups: the representation, and POST/PUT/PATCH bodies as Okta and Entra ID send
 * them (`{ op: "Add", path: "members", value: [{ value }] }`, `{ op: "Remove", path: "members[value eq \"id\"]" }`,
 * Okta's `{ op: "remove", path: "members", value: [...] }`, `{ op: "replace", value: { id, displayName } }` and
 * `{ op: "Replace", path: "displayName", value }`).
 */
import { userNames } from '../auth/users';
import { getKey, matches, parsePatchPath } from './filter';
import { changeGroup, createGroup, getGroup, groupMembers, listGroups, type GroupChange, type ScimGroup } from './groups';
import { SCHEMAS, ScimError } from './http';

export function groupResource(group: ScimGroup, base: string, names = userNames()): Record<string, unknown> {
  return {
    schemas: [SCHEMAS.group],
    id: group.id,
    ...(group.externalId && { externalId: group.externalId }),
    displayName: group.displayName,
    members: groupMembers(group.id).map((userId) => ({ value: userId, display: names.get(userId) ?? userId, $ref: `${base}/Users/${userId}`, type: 'User' })),
    meta: { resourceType: 'Group', created: group.createdAt, lastModified: group.updatedAt, location: `${base}/Groups/${group.id}` },
  };
}

export function allGroupResources(base: string): Array<Record<string, unknown>> {
  const names = userNames();
  return listGroups().map((group) => groupResource(group, base, names));
}

export function requireScimGroup(id: string): ScimGroup {
  const group = getGroup(id);
  if (!group) throw new ScimError(404, `Group ${id} not found`);
  return group;
}

/** User ids from a members value (`[{ value }]`, or one `{ value }`). */
function memberIds(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
  return list.map((member) => getKey(member, 'value')).filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/** POST /Groups. */
export function createScimGroup(body: Record<string, unknown>): ScimGroup {
  const displayName = getKey(body, 'displayName');
  if (typeof displayName !== 'string' || !displayName.trim()) throw new ScimError(400, 'displayName is required', 'invalidValue');
  const externalId = getKey(body, 'externalId');
  return createGroup({ displayName, ...(typeof externalId === 'string' && externalId && { externalId }), members: memberIds(getKey(body, 'members')) });
}

/** PUT /Groups/<id>: name, externalId (kept when absent) and the full member list. */
export function replaceScimGroup(id: string, body: Record<string, unknown>): ScimGroup {
  requireScimGroup(id);
  const displayName = getKey(body, 'displayName');
  if (typeof displayName !== 'string' || !displayName.trim()) throw new ScimError(400, 'displayName is required', 'invalidValue');
  const externalId = getKey(body, 'externalId');
  return changeGroup(id, { displayName, ...(typeof externalId === 'string' && { externalId }), members: memberIds(getKey(body, 'members')) });
}

/** PATCH /Groups/<id>. */
export function patchScimGroup(id: string, body: Record<string, unknown>): ScimGroup {
  requireScimGroup(id);
  const operations = getKey(body, 'Operations');
  if (!Array.isArray(operations) || !operations.length) throw new ScimError(400, 'A PATCH needs Operations', 'invalidSyntax');
  // Operations apply in order: replay them on a working member list, then make one change.
  let members = groupMembers(id);
  const change: GroupChange = {};
  const apply = (op: string, pathText: string, value: unknown) => {
    const path = parsePatchPath(pathText);
    const head = (path.attr[0] ?? '').toLowerCase();
    if (head === 'displayname') {
      if (op === 'remove') throw new ScimError(400, 'displayName is required', 'mutability');
      if (typeof value !== 'string') throw new ScimError(400, 'displayName must be a string', 'invalidValue');
      change.displayName = value;
    } else if (head === 'externalid') {
      change.externalId = op === 'remove' || !value ? null : String(value);
    } else if (head === 'members') {
      if (path.filter) {
        if (op !== 'remove') throw new ScimError(400, 'Only remove takes a members filter', 'invalidPath');
        const filter = path.filter;
        members = members.filter((userId) => !matches({ value: userId, type: 'User' }, filter));
      } else if (op === 'add') {
        members = [...new Set([...members, ...memberIds(value)])];
      } else if (op === 'replace') {
        members = memberIds(value);
      } else {
        const gone = new Set(memberIds(value));
        members = value === undefined || value === null ? [] : members.filter((userId) => !gone.has(userId));
      }
      change.members = members;
    }
    // Anything else (id, schemas, meta, unknown attributes) is ignored.
  };
  for (const operation of operations) {
    const op = String(getKey(operation, 'op') ?? '').toLowerCase();
    if (!['add', 'replace', 'remove'].includes(op)) throw new ScimError(400, `Unknown PATCH op “${String(getKey(operation, 'op'))}”`, 'invalidSyntax');
    const path = getKey(operation, 'path');
    const value = getKey(operation, 'value');
    if (typeof path === 'string' && path.trim()) apply(op, path.trim(), value);
    else {
      if (op === 'remove') throw new ScimError(400, 'A remove needs a path', 'noTarget');
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ScimError(400, 'A PATCH without a path needs an object value', 'invalidValue');
      for (const [key, raw] of Object.entries(value)) if (key.toLowerCase() !== 'id') apply(op, key, raw);
    }
  }
  return changeGroup(id, change);
}
