/**
 * SCIM Users (RFC 7643 §4.1) mapped onto Landflow users. `userName` is the user's email address (identity providers
 * send the email or a UPN, which is one; anything else is refused), `name`/`displayName` the display name, `active`
 * deactivation (sign-out, no sign-in, no API keys), `externalId` the provider's id. New users are members with no
 * password (they sign in through single sign-on), `provisionedBy: scim`; their instance role and project
 * memberships come from their groups (./groups). DELETE removes the user and moves what they own to the instance
 * owner's personal project.
 *
 * PATCH accepts what Okta and Entra ID send: lower- or capitalised ops, `{ op: "replace", value: { active: false } }`
 * without a path, `"active": "False"` strings, value-path paths (`emails[type eq "work"].value`), dotted keys in a
 * path-less value (`"name.givenName"`), and enterprise-extension attributes, which are accepted and ignored.
 */
import { createUser, findUserByEmail, findUserByExternalId, getUser, listUsers, normalizeEmail, setUserDisabled, updateUser, type UserRecord } from '../auth/users';
import { instanceOwnerId } from '../projects/store';
import { deleteUserWithTransfer } from '../projects/transfer';
import { getKey, parsePatchPath } from './filter';
import { groupsOf } from './groups';
import { SCHEMAS, ScimError } from './http';

const EMAIL = /^[^\s@]+@[^\s@]+$/;

function splitName(name: string): { givenName: string; familyName: string } {
  const [givenName = '', ...rest] = name.trim().split(/\s+/);
  return { givenName, familyName: rest.join(' ') };
}

/** A user as SCIM sees it. */
export function userResource(user: UserRecord, base: string): Record<string, unknown> {
  return {
    schemas: [SCHEMAS.user],
    id: user.id,
    ...(user.externalId && { externalId: user.externalId }),
    userName: user.email,
    name: { formatted: user.name, ...splitName(user.name) },
    displayName: user.name,
    emails: [{ value: user.email, type: 'work', primary: true }],
    active: !user.disabledAt,
    groups: groupsOf(user.id).map((group) => ({ value: group.id, display: group.displayName, $ref: `${base}/Groups/${group.id}`, type: 'direct' })),
    meta: { resourceType: 'User', created: user.createdAt, lastModified: user.updatedAt, location: `${base}/Users/${user.id}` },
  };
}

export function allUserResources(base: string): Array<Record<string, unknown>> {
  return listUsers().map((user) => userResource(user, base));
}

export function requireScimUser(id: string): UserRecord {
  const user = getUser(id);
  if (!user) throw new ScimError(404, `User ${id} not found`);
  return user;
}

/** What a request says about a user, and which parts it set (PATCH only changes those). */
interface Draft {
  userName?: string;
  displayName?: string;
  formatted?: string;
  givenName?: string;
  familyName?: string;
  externalId?: string | null;
  active?: boolean;
  emails?: Array<{ value?: string; type?: string; primary?: boolean }>;
}

function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' && /^(true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === 'true';
  throw new ScimError(400, `“${String(value)}” is not a boolean`, 'invalidValue');
}

const asString = (value: unknown, attribute: string): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  throw new ScimError(400, `${attribute} must be a string`, 'invalidValue');
};

/** Apply one attribute (a path, or a key of a path-less value) to the draft. Unknown and read-only attributes are ignored. */
function applyUserAttribute(draft: Draft, op: string, pathText: string, value: unknown) {
  const path = parsePatchPath(pathText);
  const [head = '', second] = path.attr;
  const remove = op === 'remove';
  switch (head.toLowerCase()) {
    case 'username':
      if (remove) throw new ScimError(400, 'userName is required', 'mutability');
      draft.userName = asString(value, 'userName');
      return;
    case 'displayname':
      draft.displayName = remove ? '' : asString(value, 'displayName');
      return;
    case 'externalid':
      draft.externalId = remove || value === null || value === '' ? null : asString(value, 'externalId');
      return;
    case 'active':
      if (!remove) draft.active = asBoolean(value);
      return;
    case 'name': {
      const set = (key: string, raw: unknown) => {
        const text = remove || raw === null || raw === undefined ? '' : asString(raw, `name.${key}`);
        if (key.toLowerCase() === 'givenname') draft.givenName = text;
        else if (key.toLowerCase() === 'familyname') draft.familyName = text;
        else if (key.toLowerCase() === 'formatted') draft.formatted = text;
      };
      if (second) set(second, value);
      else if (value && typeof value === 'object') for (const [key, raw] of Object.entries(value)) set(key, raw);
      else if (remove) draft.givenName = draft.familyName = draft.formatted = '';
      return;
    }
    case 'emails': {
      if (remove) return;
      if (path.filter || path.sub) {
        const email = path.sub ? asString(value, 'emails.value') : asString(getKey(value, 'value'), 'emails.value');
        draft.emails = [{ value: email, type: 'work', primary: true }];
      } else if (Array.isArray(value)) draft.emails = value as Draft['emails'];
      return;
    }
    default:
      // groups (read-only), password (single sign-on), roles, title, locale, phone numbers, the enterprise extension…
      return;
  }
}

/** A draft from a full representation (POST, PUT). */
function draftFrom(body: Record<string, unknown>): Draft {
  const draft: Draft = {};
  for (const [key, value] of Object.entries(body)) {
    if (['schemas', 'id', 'meta'].includes(key) || value === undefined) continue;
    applyUserAttribute(draft, 'replace', key, value);
  }
  return draft;
}

function draftEmail(draft: Draft): string {
  const userName = draft.userName?.trim() ?? '';
  if (!userName) throw new ScimError(400, 'userName is required', 'invalidValue');
  if (!EMAIL.test(userName)) throw new ScimError(400, `userName must be the user’s email address (got “${userName}”): map userName to the email or UPN in your identity provider`, 'invalidValue');
  return normalizeEmail(userName);
}

/** The display name a full representation gives, else `fallback`. */
function draftName(draft: Draft, fallback: string): string {
  const joined = [draft.givenName, draft.familyName].filter((part) => part?.trim()).join(' ');
  return (draft.displayName?.trim() || draft.formatted?.trim() || joined.trim() || fallback).slice(0, 120);
}

/** POST /Users. 409 (uniqueness) when the email or externalId belongs to someone already. */
export async function createScimUser(body: Record<string, unknown>): Promise<UserRecord> {
  const draft = draftFrom(body);
  const email = draftEmail(draft);
  if (findUserByEmail(email)) throw new ScimError(409, `A user with the userName ${email} already exists`, 'uniqueness');
  if (draft.externalId && findUserByExternalId(draft.externalId)) throw new ScimError(409, `A user with the externalId ${draft.externalId} already exists`, 'uniqueness');
  return createUser({
    email,
    name: draftName(draft, email.split('@')[0]),
    role: 'member',
    ...(draft.externalId && { externalId: draft.externalId }),
    provisionedBy: 'scim',
    disabled: draft.active === false,
  });
}

function setActive(user: UserRecord, active: boolean | undefined): UserRecord {
  if (active === undefined || active === !user.disabledAt) return user;
  return setUserDisabled(user.id, !active);
}

/** PUT /Users/<id>: replace userName, name and externalId (kept when absent); `active` when given. */
export function replaceScimUser(id: string, body: Record<string, unknown>): UserRecord {
  const user = requireScimUser(id);
  const draft = draftFrom(body);
  const email = draftEmail(draft);
  if (draft.externalId) {
    const other = findUserByExternalId(draft.externalId);
    if (other && other.id !== id) throw new ScimError(409, `Another user has the externalId ${draft.externalId}`, 'uniqueness');
  }
  const updated = updateUser(id, {
    email,
    name: draftName(draft, user.name),
    ...(draft.externalId !== undefined && draft.externalId !== null && { externalId: draft.externalId }),
  });
  return setActive(updated, draft.active);
}

/** PATCH /Users/<id> (RFC 7644 §3.5.2). */
export function patchScimUser(id: string, body: Record<string, unknown>): UserRecord {
  const user = requireScimUser(id);
  const operations = getKey(body, 'Operations');
  if (!Array.isArray(operations) || !operations.length) throw new ScimError(400, 'A PATCH needs Operations', 'invalidSyntax');
  const draft: Draft = {};
  for (const operation of operations) {
    const op = String(getKey(operation, 'op') ?? '').toLowerCase();
    if (!['add', 'replace', 'remove'].includes(op)) throw new ScimError(400, `Unknown PATCH op “${String(getKey(operation, 'op'))}”`, 'invalidSyntax');
    const path = getKey(operation, 'path');
    const value = getKey(operation, 'value');
    if (typeof path === 'string' && path.trim()) {
      applyUserAttribute(draft, op, path.trim(), value);
    } else {
      if (op === 'remove') throw new ScimError(400, 'A remove needs a path', 'noTarget');
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ScimError(400, 'A PATCH without a path needs an object value', 'invalidValue');
      for (const [key, raw] of Object.entries(value)) {
        // The enterprise extension as an object (department, manager…): nothing in Landflow to set.
        if (key.toLowerCase().startsWith('urn:') && raw && typeof raw === 'object') continue;
        applyUserAttribute(draft, op, key, raw);
      }
    }
  }
  const patch: Parameters<typeof updateUser>[1] = {};
  if (draft.userName !== undefined) patch.email = draftEmail(draft);
  if (draft.displayName?.trim()) patch.name = draft.displayName.trim().slice(0, 120);
  else if (draft.formatted?.trim()) patch.name = draft.formatted.trim().slice(0, 120);
  else if (draft.givenName !== undefined || draft.familyName !== undefined) {
    const current = splitName(user.name);
    const joined = [draft.givenName ?? current.givenName, draft.familyName ?? current.familyName].filter((part) => part.trim()).join(' ');
    if (joined) patch.name = joined.slice(0, 120);
  }
  if (draft.externalId !== undefined) {
    if (draft.externalId) {
      const other = findUserByExternalId(draft.externalId);
      if (other && other.id !== id) throw new ScimError(409, `Another user has the externalId ${draft.externalId}`, 'uniqueness');
    }
    patch.externalId = draft.externalId ?? undefined;
  }
  const updated = Object.keys(patch).length ? updateUser(id, patch) : user;
  return setActive(updated, draft.active);
}

/** DELETE /Users/<id>: remove the user; what they own goes to the instance owner's personal project. */
export function deleteScimUser(id: string, actorId?: string) {
  const user = requireScimUser(id);
  if (user.role === 'owner') throw new ScimError(403, 'The owner can’t be removed through SCIM', 'mutability');
  const owner = instanceOwnerId();
  deleteUserWithTransfer(id, owner ? { userId: owner } : undefined, actorId);
}
