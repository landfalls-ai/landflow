/**
 * Users, in the `users` table: email (unique, lower-cased), name, role, a scrypt password hash (none for users who
 * only sign in through SSO) and the OIDC identity they signed in with. The first user is the owner, created by the
 * setup page or from LANDFLOW_OWNER_EMAIL / LANDFLOW_OWNER_PASSWORD at boot (./bootstrap).
 */
import { nanoid } from 'nanoid';
import type { Role, UserView, Viewer } from '../../shared/auth';
import { authDb } from './db';
import { hashPassword } from './passwords';

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  role: Role;
  passwordHash?: string;
  oidcIssuer?: string;
  oidcSubject?: string;
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
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export class UserError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const ROLE_SET = new Set<string>(['owner', 'admin', 'member']);

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

function fromRow(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: (ROLE_SET.has(row.role) ? row.role : 'member') as Role,
    ...(row.password_hash && { passwordHash: row.password_hash }),
    ...(row.oidc_issuer && { oidcIssuer: row.oidc_issuer }),
    ...(row.oidc_subject && { oidcSubject: row.oidc_subject }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_login_at && { lastLoginAt: row.last_login_at }),
  };
}

function toRow(user: UserRecord) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    password_hash: user.passwordHash ?? null,
    oidc_issuer: user.oidcIssuer ?? null,
    oidc_subject: user.oidcSubject ?? null,
    created_at: user.createdAt,
    updated_at: user.updatedAt,
    last_login_at: user.lastLoginAt ?? null,
  };
}

export function viewerOf(user: UserRecord): Viewer {
  return { id: user.id, name: user.name, email: user.email, role: user.role, sso: Boolean(user.oidcSubject), hasPassword: Boolean(user.passwordHash) };
}

export function userView(user: UserRecord): UserView {
  return { ...viewerOf(user), createdAt: user.createdAt, ...(user.lastLoginAt && { lastLoginAt: user.lastLoginAt }) };
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
    .all<UserRow>('SELECT * FROM users ORDER BY created_at, email')
    .map(fromRow);
}

export function getUser(id: string): UserRecord | undefined {
  const row = authDb().get<UserRow>('SELECT * FROM users WHERE id = ?', id);
  return row && fromRow(row);
}

export function findUserByEmail(email: string): UserRecord | undefined {
  const row = authDb().get<UserRow>('SELECT * FROM users WHERE email = ?', normalizeEmail(email));
  return row && fromRow(row);
}

export function findUserByOidc(issuer: string, subject: string): UserRecord | undefined {
  const row = authDb().get<UserRow>('SELECT * FROM users WHERE oidc_subject = ? AND oidc_issuer = ?', subject, issuer);
  return row && fromRow(row);
}

export interface NewUser {
  email: string;
  name: string;
  role: Role;
  password?: string;
  oidc?: { issuer: string; subject: string };
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

export function updateUser(id: string, patch: Partial<Pick<UserRecord, 'name' | 'role' | 'passwordHash' | 'oidcIssuer' | 'oidcSubject' | 'lastLoginAt'>>): UserRecord {
  const existing = getUser(id);
  if (!existing) throw new UserError('User not found', 404);
  const updated: UserRecord = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  if (patch.name !== undefined) updated.name = patch.name.trim().slice(0, 120) || existing.name;
  authDb().upsert('users', toRow(updated));
  return updated;
}

export async function setPassword(id: string, password: string): Promise<UserRecord> {
  return updateUser(id, { passwordHash: await hashPassword(password) });
}

/** Remove a user with their sessions and API keys (what they built stays). */
export function deleteUser(id: string): boolean {
  const db = authDb();
  return db.transaction(() => {
    db.delete('sessions', { user_id: id });
    db.delete('api_keys', { user_id: id });
    return db.delete('users', { id }) > 0;
  });
}

/** Display names by user id, for "created by" and lock labels. */
export function userNames(): Map<string, string> {
  return new Map(authDb().all<{ id: string; name: string }>('SELECT id, name FROM users').map((row) => [row.id, row.name]));
}
