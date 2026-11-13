/**
 * Sign-in sessions: a random token in the session cookie, kept as its SHA-256 in `sessions` with an expiry
 * (LANDFLOW_SESSION_TTL_HOURS, default 14 days) and an idle limit (LANDFLOW_SESSION_IDLE_HOURS). Signing out deletes the row; removing a user or resetting their
 * password deletes all of theirs. Expired rows are swept when sessions are created. A deactivated user (SCIM) gets
 * no session, and the sessions they had stop working.
 */
import { recordAudit } from '../audit';
import { isProduction } from '../config';
import { authDb } from './db';
import { randomToken, tokenHash } from './passwords';
import { getUser, updateUser, UserError, type UserRecord } from './users';

export type SessionMethod = 'password' | 'oidc' | 'saml' | 'setup' | 'invite' | 'reset';

export const DEACTIVATED_MESSAGE = 'This account is deactivated. Ask an admin to reactivate it.';

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

/** LANDFLOW_SESSION_IDLE_HOURS: a session unused this long is refused (default 72 in production, off in development; 0 = off). */
export function sessionIdleHours(): number {
  const raw = process.env.LANDFLOW_SESSION_IDLE_HOURS;
  const configured = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  if (Number.isFinite(configured) && configured >= 0) return Math.min(configured, 24 * 365);
  return isProduction() ? 72 : 0;
}

/** Start a session for `user`: returns the cookie token (shown nowhere else) and when it expires. */
export function createSession(user: UserRecord, method: SessionMethod, meta: { ip?: string; userAgent?: string } = {}): { token: string; expiresAt: Date } {
  if (user.disabledAt || getUser(user.id)?.disabledAt) throw new UserError(DEACTIVATED_MESSAGE, 403);
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
  // Every way in (password, OIDC, SAML, setup, an accepted invite) starts here: one audit event for all of them.
  recordAudit({ action: 'auth.sign_in', actor: { id: user.id, name: user.name, email: user.email }, target: { type: 'user', id: user.id, name: user.email }, summary: `${user.email} signed in (${method})`, details: { method } });
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
  // Idle: last_seen_at is touched at most once a minute, so this is accurate to about that.
  const idleMs = sessionIdleHours() * 3_600_000;
  if (idleMs > 0 && row.last_seen_at && now - Date.parse(row.last_seen_at) > idleMs) {
    db.delete('sessions', { id: row.id });
    return undefined;
  }
  const user = getUser(row.user_id);
  if (!user || user.disabledAt) return undefined;
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
