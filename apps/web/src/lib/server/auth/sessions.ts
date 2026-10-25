/**
 * Sign-in sessions: a random token in the session cookie, kept as its SHA-256 in `sessions` with an expiry
 * (LANDFLOW_SESSION_TTL_HOURS, default 14 days). Signing out deletes the row; removing a user or resetting their
 * password deletes all of theirs. Expired rows are swept when sessions are created.
 */
import { authDb } from './db';
import { randomToken, tokenHash } from './passwords';
import { getUser, updateUser, type UserRecord } from './users';

export type SessionMethod = 'password' | 'oidc' | 'setup' | 'invite' | 'reset';

export interface SessionRecord {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  method: SessionMethod;
}

interface SessionRow {
  id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string | null;
  method: string;
  ip: string | null;
  user_agent: string | null;
}

const DEFAULT_TTL_HOURS = 24 * 14;
/** last_seen_at is written at most this often per session. */
const TOUCH_EVERY_MS = 60_000;

export function sessionTtlHours(): number {
  const configured = Number(process.env.LANDFLOW_SESSION_TTL_HOURS);
  return Number.isFinite(configured) && configured > 0 ? Math.min(configured, 24 * 365) : DEFAULT_TTL_HOURS;
}

/** Start a session for `user`: returns the cookie token (shown nowhere else) and when it expires. */
export function createSession(user: UserRecord, method: SessionMethod, meta: { ip?: string; userAgent?: string } = {}): { token: string; expiresAt: Date } {
  const db = authDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + sessionTtlHours() * 3_600_000);
  const token = randomToken(32);
  db.transaction(() => {
    db.deleteBefore('sessions', 'expires_at', now.toISOString());
    db.insertNew('sessions', {
      id: tokenHash(token),
      user_id: user.id,
      created_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      last_seen_at: now.toISOString(),
      method,
      ip: meta.ip?.slice(0, 64),
      user_agent: meta.userAgent?.slice(0, 300),
    });
  });
  updateUser(user.id, { lastLoginAt: now.toISOString() });
  return { token, expiresAt };
}

/** The user of a valid, unexpired session token, else undefined. */
export function sessionUser(token: string | undefined, now = Date.now()): { user: UserRecord; session: SessionRecord } | undefined {
  if (!token || token.length > 200) return undefined;
  const db = authDb();
  const row = db.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', tokenHash(token));
  if (!row) return undefined;
  if (Date.parse(row.expires_at) <= now) {
    db.delete('sessions', { id: row.id });
    return undefined;
  }
  const user = getUser(row.user_id);
  if (!user) return undefined;
  if (!row.last_seen_at || now - Date.parse(row.last_seen_at) > TOUCH_EVERY_MS) db.upsert('sessions', { ...row, last_seen_at: new Date(now).toISOString() });
  return { user, session: { id: row.id, userId: row.user_id, createdAt: row.created_at, expiresAt: row.expires_at, method: row.method as SessionMethod } };
}

/** Sign out: forget the session of this token. */
export function deleteSession(token: string | undefined): boolean {
  if (!token) return false;
  return authDb().delete('sessions', { id: tokenHash(token) }) > 0;
}

/** Sign a user out everywhere (password reset, removal). */
export function deleteUserSessions(userId: string): number {
  return authDb().delete('sessions', { user_id: userId });
}
