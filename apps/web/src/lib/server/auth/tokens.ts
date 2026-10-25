/**
 * One-time links in `auth_tokens`: invites (an email and a role, valid 7 days) and password resets (a user, valid
 * one hour). The link carries a random token; only its SHA-256 is kept. Using one marks it used; a new invite for
 * the same email, or a new reset for the same user, replaces the older one.
 */
import { nanoid } from 'nanoid';
import type { AssignableRole, InviteView } from '../../shared/auth';
import { authDb } from './db';
import { randomToken, tokenHash } from './passwords';
import { normalizeEmail } from './users';

export type TokenKind = 'invite' | 'reset';

export interface AuthTokenRecord {
  id: string;
  kind: TokenKind;
  email: string;
  userId?: string;
  role?: AssignableRole;
  createdBy?: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
}

interface TokenRow {
  id: string;
  kind: string;
  token_hash: string;
  email: string;
  user_id: string | null;
  role: string | null;
  created_by: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

export const INVITE_TTL_MS = 7 * 86_400_000;
export const RESET_TTL_MS = 3_600_000;

function fromRow(row: TokenRow): AuthTokenRecord {
  return {
    id: row.id,
    kind: row.kind as TokenKind,
    email: row.email,
    ...(row.user_id && { userId: row.user_id }),
    ...(row.role && { role: row.role as AssignableRole }),
    ...(row.created_by && { createdBy: row.created_by }),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.used_at && { usedAt: row.used_at }),
  };
}

/** Pending (unused, unexpired) tokens of a kind matching `where`. */
function pending(kind: TokenKind, column: 'email' | 'user_id', value: string, now = new Date().toISOString()): TokenRow[] {
  return authDb().all<TokenRow>(`SELECT * FROM auth_tokens WHERE kind = ? AND ${column} = ? AND used_at IS NULL AND expires_at > ?`, kind, value, now);
}

function issue(record: Omit<AuthTokenRecord, 'id' | 'createdAt' | 'expiresAt'>, ttlMs: number): { record: AuthTokenRecord; token: string } {
  const db = authDb();
  const token = randomToken(32);
  const now = new Date();
  const row: TokenRow = {
    id: `${record.kind === 'invite' ? 'inv' : 'rst'}_${nanoid(12)}`,
    kind: record.kind,
    token_hash: tokenHash(token),
    email: normalizeEmail(record.email),
    user_id: record.userId ?? null,
    role: record.role ?? null,
    created_by: record.createdBy ?? null,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlMs).toISOString(),
    used_at: null,
  };
  db.transaction(() => {
    db.deleteBefore('auth_tokens', 'expires_at', now.toISOString());
    // One pending link per invitee or user: a new one replaces the old.
    const older = record.kind === 'invite' ? pending('invite', 'email', row.email) : pending('reset', 'user_id', row.user_id ?? '');
    for (const old of older) db.delete('auth_tokens', { id: old.id });
    db.insertNew('auth_tokens', { ...row });
  });
  return { record: fromRow(row), token };
}

export function createInvite(email: string, role: AssignableRole, createdBy?: string): { record: AuthTokenRecord; token: string } {
  return issue({ kind: 'invite', email, role, ...(createdBy && { createdBy }) }, INVITE_TTL_MS);
}

export function createResetToken(user: { id: string; email: string }, createdBy?: string): { record: AuthTokenRecord; token: string } {
  return issue({ kind: 'reset', email: user.email, userId: user.id, ...(createdBy && { createdBy }) }, RESET_TTL_MS);
}

/** The pending token of a link, if it is of `kind`, unused and unexpired. */
export function findToken(kind: TokenKind, token: string | undefined, now = Date.now()): AuthTokenRecord | undefined {
  if (!token || token.length > 200) return undefined;
  const row = authDb().get<TokenRow>('SELECT * FROM auth_tokens WHERE token_hash = ?', tokenHash(token));
  if (!row || row.kind !== kind || row.used_at || Date.parse(row.expires_at) <= now) return undefined;
  return fromRow(row);
}

export function markTokenUsed(id: string) {
  const db = authDb();
  const row = db.get<TokenRow>('SELECT * FROM auth_tokens WHERE id = ?', id);
  if (row) db.upsert('auth_tokens', { ...row, used_at: new Date().toISOString() });
}

export function listInvites(now = new Date().toISOString()): AuthTokenRecord[] {
  return authDb()
    .all<TokenRow>(`SELECT * FROM auth_tokens WHERE kind = 'invite' AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC`, now)
    .map(fromRow);
}

export function deleteInvite(id: string): boolean {
  const db = authDb();
  const row = db.get<TokenRow>(`SELECT id FROM auth_tokens WHERE id = ? AND kind = 'invite'`, id);
  return row ? db.delete('auth_tokens', { id }) > 0 : false;
}

export function inviteView(record: AuthTokenRecord, names: Map<string, string>): InviteView {
  return {
    id: record.id,
    email: record.email,
    role: record.role ?? 'member',
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    ...(record.createdBy && names.get(record.createdBy) && { invitedBy: names.get(record.createdBy) }),
  };
}
