/**
 * Users, in the `users` table: email (unique, lower-cased), name, role, a scrypt password hash (none for users who
 * only sign in through SSO) and the OIDC identity they signed in with. The first user is the owner, created by the
 * setup page or from LANDFLOW_OWNER_EMAIL / LANDFLOW_OWNER_PASSWORD at boot (./bootstrap).
 *
 * Wave 4 adds the SAML identity (`samlIssuer`, `samlSubject`), the identity provider's id of a provisioned user
 * (`externalId`, `provisionedBy`: `scim` or `saml`) and deactivation (`disabledAt`): a deactivated user has no
 * sessions, and can't sign in or use their API keys (./sessions, ./api-keys) until reactivated.
 */
import { nanoid } from 'nanoid';
import { parseStoredActions, type Action, type Role, type UserView, type Viewer } from '../../shared/auth';
import { recordAudit } from '../audit';
import { auditRequestContext } from '../audit/context';
import { requestAuth } from './context';
import { authDb } from './db';
import { hashPassword } from './passwords';
import { HttpError } from '../errors';

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  role: Role;
  passwordHash?: string;
  oidcIssuer?: string;
  oidcSubject?: string;
  samlIssuer?: string;
  samlSubject?: string;
  /** The identity provider's id (SCIM `externalId`). */
  externalId?: string;
  /** Created by provisioning: `scim`, or `saml` (just-in-time). */
  provisionedBy?: string;
  /** Deactivated (SCIM `active: false`): no sign-in, no API keys. */
  disabledAt?: string;
  /**
   * The custom role a member holds (C32) and what it grants, joined on every read so an edit or a delete shows at the
   * holder's next request with no cache. Only members hold one (the read ignores it on anyone else).
   */
  customRole?: { id: string; name: string; actions: Action[] };
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: string;
  password_hash: string | null;
  oidc_issuer: string | null;
  oidc_subject: string | null;
  saml_issuer?: string | null;
  saml_subject?: string | null;
  external_id?: string | null;
  provisioned_by?: string | null;
  disabled_at?: string | null;
  custom_role_id?: string | null;
  custom_role_name?: string | null;
  custom_role_rules?: string | null;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export class UserError extends HttpError {
  static readonly errorName: string = 'UserError';
  constructor(
    message: string,
    status = 400,
  ) {
    super(message, status, { expose: true });
  }
}

const ROLE_SET = new Set<string>(['owner', 'admin', 'member']);

/** Every whole-user read: the user with the custom role it holds (C32). `u.*` keeps `custom_role_id` for the write path. */
export const USER_SELECT = 'SELECT u.*, r.name AS custom_role_name, r.rules AS custom_role_rules FROM users u LEFT JOIN custom_roles r ON r.id = u.custom_role_id';

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

function fromRow(row: UserRow): UserRecord {
  const role = (ROLE_SET.has(row.role) ? row.role : 'member') as Role;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role,
    ...(row.password_hash && { passwordHash: row.password_hash }),
    ...(row.oidc_issuer && { oidcIssuer: row.oidc_issuer }),
    ...(row.oidc_subject && { oidcSubject: row.oidc_subject }),
    ...(row.saml_issuer && { samlIssuer: row.saml_issuer }),
    ...(row.saml_subject && { samlSubject: row.saml_subject }),
    ...(row.external_id && { externalId: row.external_id }),
    ...(row.provisioned_by && { provisionedBy: row.provisioned_by }),
    ...(row.disabled_at && { disabledAt: row.disabled_at }),
    ...(role === 'member' && row.custom_role_id && row.custom_role_name != null && { customRole: { id: row.custom_role_id, name: row.custom_role_name, actions: parseStoredActions(row.custom_role_rules) } }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_login_at && { lastLoginAt: row.last_login_at }),
  };
}

function toRow(user: UserRecord, customRoleId: string | null = user.customRole?.id ?? null) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    password_hash: user.passwordHash ?? null,
    oidc_issuer: user.oidcIssuer ?? null,
    oidc_subject: user.oidcSubject ?? null,
    saml_issuer: user.samlIssuer ?? null,
    saml_subject: user.samlSubject ?? null,
    external_id: user.externalId ?? null,
    provisioned_by: user.provisionedBy ?? null,
    disabled_at: user.disabledAt ?? null,
    custom_role_id: customRoleId,
    created_at: user.createdAt,
    updated_at: user.updatedAt,
    last_login_at: user.lastLoginAt ?? null,
  };
}

export function viewerOf(user: UserRecord): Viewer {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    sso: Boolean(user.oidcSubject || user.samlSubject),
    hasPassword: Boolean(user.passwordHash),
    ...(user.disabledAt && { disabled: true }),
    ...(user.provisionedBy && { provisionedBy: user.provisionedBy }),
    // C32: what the role grants travels with the viewer, so every client gate (`can`) shows the holder's controls.
    ...(user.customRole && { customRole: { id: user.customRole.id, name: user.customRole.name }, grants: [...user.customRole.actions] }),
  };
}

/** `mfaFactors`: the user's confirmed second factors (counted by `mfaFactorCounts`); never pass `userView` straight to `map`. */
export function userView(user: UserRecord, mfaFactors?: number): UserView {
  return { ...viewerOf(user), ...(mfaFactors ? { mfaFactors } : {}), createdAt: user.createdAt, ...(user.lastLoginAt && { lastLoginAt: user.lastLoginAt }) };
}

export function countUsers(): number {
  return Number(authDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0);
}

/** No user yet: the setup page (or the owner env variables) creates the owner. */
export function setupRequired(): boolean {
  return countUsers() === 0;
}

export function listUsers(): UserRecord[] {
  return authDb()
    .all<UserRow>(`${USER_SELECT} ORDER BY u.created_at, u.email`)
    .map(fromRow);
}

export function getUser(id: string): UserRecord | undefined {
  const row = authDb().get<UserRow>(`${USER_SELECT} WHERE u.id = ?`, id);
  return row && fromRow(row);
}

/** An active (not deactivated) owner or admin: who may vouch for what the briefing nodes use (lib/server/nodes/briefing.ts). */
export function isActiveAdmin(id: string | undefined): boolean {
  const user = id ? getUser(id) : undefined;
  return Boolean(user && !user.disabledAt && (user.role === 'owner' || user.role === 'admin'));
}

export function findUserByEmail(email: string): UserRecord | undefined {
  const row = authDb().get<UserRow>(`${USER_SELECT} WHERE u.email = ?`, normalizeEmail(email));
  return row && fromRow(row);
}

export function findUserByOidc(issuer: string, subject: string): UserRecord | undefined {
  const row = authDb().get<UserRow>(`${USER_SELECT} WHERE u.oidc_subject = ? AND u.oidc_issuer = ?`, subject, issuer);
  return row && fromRow(row);
}

export function findUserBySaml(issuer: string, subject: string): UserRecord | undefined {
  const row = authDb().get<UserRow>(`${USER_SELECT} WHERE u.saml_subject = ? AND u.saml_issuer = ?`, subject, issuer);
  return row && fromRow(row);
}

export function findUserByExternalId(externalId: string): UserRecord | undefined {
  const row = authDb().get<UserRow>(`${USER_SELECT} WHERE u.external_id = ?`, externalId);
  return row && fromRow(row);
}

export interface NewUser {
  email: string;
  name: string;
  role: Role;
  password?: string;
  oidc?: { issuer: string; subject: string };
  saml?: { issuer: string; subject: string };
  externalId?: string;
  provisionedBy?: string;
  disabled?: boolean;
}

const EMAIL = /^[^\s@]+@[^\s@]+$/;

/** Create a user. Throws UserError for a taken or invalid email, or a second owner. */
export async function createUser(input: NewUser): Promise<UserRecord> {
  const email = normalizeEmail(input.email);
  if (!EMAIL.test(email) || email.length > 320) throw new UserError('Enter a valid email address');
  const passwordHash = input.password ? await hashPassword(input.password) : undefined;
  const db = authDb();
  return db.transaction(() => {
    if (findUserByEmail(email)) throw new UserError(`A user with the email ${email} already exists`, 409);
    if (input.role === 'owner' && db.get('SELECT id FROM users WHERE role = ?', 'owner')) throw new UserError('This instance already has an owner', 409);
    const now = new Date().toISOString();
    const user: UserRecord = {
      id: `usr_${nanoid(12)}`,
      email,
      name: input.name.trim().slice(0, 120) || email.split('@')[0],
      role: input.role,
      ...(passwordHash && { passwordHash }),
      ...(input.oidc && { oidcIssuer: input.oidc.issuer, oidcSubject: input.oidc.subject }),
      ...(input.saml && { samlIssuer: input.saml.issuer, samlSubject: input.saml.subject }),
      ...(input.externalId && { externalId: input.externalId }),
      ...(input.provisionedBy && { provisionedBy: input.provisionedBy }),
      ...(input.disabled && { disabledAt: now }),
      createdAt: now,
      updatedAt: now,
    };
    db.insertNew('users', toRow(user));
    return user;
  });
}

/** Create the owner, only while there is no user at all (setup page and env bootstrap). */
export async function createOwner(input: { email: string; name: string; password: string }): Promise<UserRecord> {
  const passwordHash = await hashPassword(input.password);
  const db = authDb();
  return db.transaction(() => {
    if (countUsers() > 0) throw new UserError('Setup is already done: sign in instead', 409);
    const email = normalizeEmail(input.email);
    if (!EMAIL.test(email)) throw new UserError('Enter a valid email address');
    const now = new Date().toISOString();
    const user: UserRecord = { id: `usr_${nanoid(12)}`, email, name: input.name.trim().slice(0, 120) || email.split('@')[0], role: 'owner', passwordHash, createdAt: now, updatedAt: now };
    db.insertNew('users', toRow(user));
    return user;
  });
}

export type UserPatch = Partial<
  Pick<UserRecord, 'name' | 'email' | 'role' | 'passwordHash' | 'oidcIssuer' | 'oidcSubject' | 'samlIssuer' | 'samlSubject' | 'externalId' | 'provisionedBy' | 'disabledAt' | 'lastLoginAt'>
> & {
  /** The custom role id (C32; undefined clears it). Only members keep one: a role change to admin clears it. Assign through lib/server/auth/roles.ts, which checks and audits. */
  customRoleId?: string;
};

/** Change a user. A key set to `undefined` clears that field (`disabledAt: undefined` reactivates). */
export function updateUser(id: string, patch: UserPatch): UserRecord {
  const { customRoleId, ...rest } = patch;
  const wantsRole = 'customRoleId' in patch;
  patch = rest;
  const existing = getUser(id);
  if (!existing) throw new UserError('User not found', 404);
  if (patch.email !== undefined) {
    const email = normalizeEmail(patch.email);
    if (!EMAIL.test(email) || email.length > 320) throw new UserError('Enter a valid email address');
    const taken = findUserByEmail(email);
    if (taken && taken.id !== id) throw new UserError(`A user with the email ${email} already exists`, 409);
    patch = { ...patch, email };
  }
  const updated: UserRecord = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  for (const [key, value] of Object.entries(patch)) if (value === undefined) delete (updated as unknown as Record<string, unknown>)[key];
  if (patch.name !== undefined) updated.name = patch.name.trim().slice(0, 120) || existing.name;
  // C32: an admin holds every action, so promoting a holder clears the role (D7); the owner never holds one.
  const nextRole = wantsRole ? customRoleId : existing.customRole?.id;
  const keepRole = updated.role === 'member' ? (nextRole ?? null) : null;
  authDb().upsert('users', toRow(updated, keepRole));
  if (existing.customRole && keepRole === null && updated.role !== 'member' && !wantsRole) {
    recordAudit({ action: 'user.custom_role', target: { type: 'user', id, name: existing.email }, summary: `${existing.email} is ${updated.role} now, so the custom role ${existing.customRole.name} was cleared`, details: { from: existing.customRole.name, to: null, reason: 'role_change' } });
  }
  return getUser(id) ?? updated;
}

/**
 * Set a user's password and record `auth.password_change` with who did it: `self` (the user, signed in), `admin` (another
 * user) or `reset` (a reset link, which has its own `auth.password_reset` event, so none is recorded here). Without a
 * reason it is taken from the request: the signed-in user changing their own, or someone else changing it; no signed-in
 * user (a reset link) records nothing.
 */
export async function setPassword(id: string, password: string, reason?: 'self' | 'admin' | 'reset'): Promise<UserRecord> {
  const updated = updateUser(id, { passwordHash: await hashPassword(password) });
  const actor = requestAuth()?.principal ?? auditRequestContext()?.principal;
  const why = reason ?? (actor ? (actor.user.id === id ? 'self' : 'admin') : 'reset');
  // A changed password ends the other sign-ins (someone who knew the old one may hold one); your own stays. The reset
  // route signs everything out itself.
  let sessionsRevoked = 0;
  if (why !== 'reset') {
    const keep = why === 'self' ? actor?.sessionId : undefined;
    const db = authDb();
    db.transaction(() => {
      for (const row of db.all<{ id: string }>('SELECT id FROM sessions WHERE user_id = ?', id)) {
        if (row.id !== keep) sessionsRevoked += db.delete('sessions', { id: row.id });
      }
    });
  }
  if (why !== 'reset') recordAudit({ action: 'auth.password_change', target: { type: 'user', id, name: updated.email }, summary: why === 'self' ? `${updated.email} changed their password` : `Changed ${updated.email}’s password`, details: { reason: why, sessionsRevoked } });
  return updated;
}

/** Remove a user with their sessions, API keys, conversations, preferences and private work events (what they built stays). */
export function deleteUser(id: string): boolean {
  const db = authDb();
  return db.transaction(() => {
    db.delete('sessions', { user_id: id });
    // The keys' use counts go with them (api_key_uses is keyed by the key's id).
    for (const key of db.all<{ id: string }>('SELECT id FROM api_keys WHERE user_id = ?', id)) db.delete('api_key_uses', { key_id: key.id });
    db.delete('api_keys', { user_id: id });
    // What only this person could read goes with them: their conversations (owner-only, no admin read), their
    // preferences and their private work events (docs/work-and-briefings.md). Shared work stays with the brain.
    for (const row of db.all<{ id: string }>('SELECT id FROM conversations WHERE user_id = ?', id)) db.delete('conversation_items', { conversation_id: row.id });
    db.delete('conversations', { user_id: id });
    db.delete('user_preferences', { user_id: id });
    db.delete('usage_events', { owner_id: id, visibility: 'private' });
    return db.delete('users', { id }) > 0;
  });
}

/**
 * Deactivate a user (SCIM `active: false`) or reactivate them. Deactivating signs them out everywhere; their API keys
 * stop working while they are deactivated (./api-keys). The owner can't be deactivated.
 */
export function setUserDisabled(id: string, disabled: boolean): UserRecord {
  const db = authDb();
  return db.transaction(() => {
    const user = getUser(id);
    if (!user) throw new UserError('User not found', 404);
    if (disabled && user.role === 'owner') throw new UserError('The owner can’t be deactivated', 403);
    if (disabled === Boolean(user.disabledAt)) return user;
    if (disabled) db.delete('sessions', { user_id: id });
    return updateUser(id, { disabledAt: disabled ? new Date().toISOString() : undefined });
  });
}

/** Display names by user id, for "created by" and lock labels. */
export function userNames(): Map<string, string> {
  return new Map(authDb().all<{ id: string; name: string }>('SELECT id, name FROM users').map((row) => [row.id, row.name]));
}

/** Confirmed second factors per user id (Settings → Users shows who has one). */
export function mfaFactorCounts(): Map<string, number> {
  return new Map(authDb().all<{ user_id: string; n: number }>('SELECT user_id, COUNT(*) AS n FROM user_mfa_factors WHERE confirmed_at IS NOT NULL GROUP BY user_id').map((row) => [row.user_id, Number(row.n)]));
}
