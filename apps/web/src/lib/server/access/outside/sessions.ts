/**
 * The requester session of a person without a Landflow account: cookie `landflow_requester` (a random token, only its SHA-256 is kept),
 * 8 hours at most and 2 hours idle, created only by a verified email link or Google sign-in (so a session can't be planted or fixed:
 * every sign-in makes a new token and ends the browser's old one). Every request re-checks what the session was granted for: the
 * feature still on, the domain still allowed, the requester not blocked, the address not now a Landflow user's. It is read here and
 * nowhere else: Landflow's own guard reads only `landflow_session`, so this cookie opens nothing but `/request-access/api/*`.
 */
import { nanoid } from 'nanoid';
import { readCookie } from '../../auth/cookies';
import { randomToken, tokenHash } from '../../auth/passwords';
import { database } from '../../db';
import { REQUESTER_COOKIE } from '../../../shared/auth-paths';
import type { OutsideRequester } from './identity';
import { outsideSettings, domainAllowed } from './settings';
import { deleteSessionRow, deleteSessionRowsOf, insertSession, landflowUserWithEmail, requesterRow, saveRequester, sessionRowByHash, sessionsOf, toRequester, touchSession, type SessionRow } from './store';

const MINUTE = 60_000;
export const SESSION_TTL_MS = 8 * 60 * MINUTE;
export const SESSION_IDLE_MS = 2 * 60 * MINUTE;
/** A requester's browsers and phones: past it, the oldest session ends. */
export const MAX_SESSIONS = 5;
/** The idle clock moves at most this often (a write a minute, not one per request). */
const TOUCH_EVERY_MS = MINUTE;

const iso = (ms: number) => new Date(ms).toISOString();

/** Start a session for a requester who just proved their address. `replacing` is the browser's old token, ended with it. */
export function startSession(requesterId: string, method: 'link' | 'google', meta: { ip?: string; userAgent?: string; replacing?: string; now?: number } = {}): { token: string; expiresAt: Date } {
  const now = meta.now ?? Date.now();
  if (meta.replacing) {
    const old = sessionRowByHash(tokenHash(meta.replacing));
    if (old) deleteSessionRow(old.id);
  }
  pruneSessions(now);
  const live = sessionsOf(requesterId);
  for (const extra of live.slice(0, Math.max(0, live.length - (MAX_SESSIONS - 1)))) deleteSessionRow(extra.id);
  const token = randomToken(32);
  insertSession({
    id: `os_${nanoid(12)}`,
    token_hash: tokenHash(token),
    requester_id: requesterId,
    method,
    created_at: iso(now),
    expires_at: iso(now + SESSION_TTL_MS),
    last_seen_at: iso(now),
    ip: meta.ip?.slice(0, 64) ?? null,
    user_agent: meta.userAgent?.slice(0, 200) ?? null,
  });
  return { token, expiresAt: new Date(now + SESSION_TTL_MS) };
}

/**
 * Why a requester may not use the page now, or undefined when they may: the feature is off, their domain was removed, they were blocked,
 * or their address became a Landflow user's (never two identities for one address).
 */
export function requesterRefusal(requesterId: string): 'off' | 'domain' | 'blocked' | 'landflow_user' | 'unknown' | undefined {
  const row = requesterRow(requesterId);
  if (!row) return 'unknown';
  const settings = outsideSettings();
  if (!settings.enabled) return 'off';
  if (!domainAllowed(row.email, settings)) return 'domain';
  if (row.blocked_at) return 'blocked';
  if (landflowUserWithEmail(row.email)) return 'landflow_user';
  return undefined;
}

/**
 * The person behind a request's requester cookie, or null: no cookie, an unknown or ended session, one past its 8 hours or idle for
 * 2, or a requester who may no longer ask (that session is deleted). Touches the session at most once a minute.
 */
export async function requesterFromRequest(req: Request, options: { now?: number; touch?: boolean } = {}): Promise<OutsideRequester | null> {
  const token = readCookie(req, REQUESTER_COOKIE);
  if (!token || token.length > 200) return null;
  return requesterFromToken(token, options);
}

/** The same for a token already read from a cookie. */
export function requesterFromToken(token: string, options: { now?: number; touch?: boolean } = {}): OutsideRequester | null {
  const now = options.now ?? Date.now();
  const session = sessionRowByHash(tokenHash(token));
  if (!session) return null;
  if (Date.parse(session.expires_at) <= now || now - Date.parse(session.last_seen_at) >= SESSION_IDLE_MS) {
    deleteSessionRow(session.id);
    return null;
  }
  if (requesterRefusal(session.requester_id)) {
    deleteSessionRow(session.id);
    return null;
  }
  const row = requesterRow(session.requester_id);
  if (!row) return null;
  if (options.touch !== false && now - Date.parse(session.last_seen_at) >= TOUCH_EVERY_MS) {
    touchSession(session, iso(now));
    saveRequester({ ...row, last_seen_at: iso(now) });
  }
  return toRequester(row);
}

/** End one session by its cookie token (sign out); true when there was one. */
export function endSession(token: string | undefined): SessionRow | undefined {
  if (!token) return undefined;
  const session = sessionRowByHash(tokenHash(token));
  if (session) deleteSessionRow(session.id);
  return session;
}

/** End every session of a requester (Block, a domain removed, an address that became a user's). */
export function endSessionsFor(requesterId: string): number {
  return deleteSessionRowsOf(requesterId);
}

/** Delete the sessions that ended. Opportunistic (each sign-in) and by `pruneOutside` (the hourly pass). */
export function pruneSessions(now = Date.now()): number {
  return database().deleteBefore('access_outside_sessions', 'expires_at', iso(now)) + database().deleteBefore('access_outside_sessions', 'last_seen_at', iso(now - SESSION_IDLE_MS));
}

/** The hourly pass: used and expired links and ended sessions go; requesters stay (requests point at them). */
export function pruneOutside(now = Date.now()): { links: number; sessions: number } {
  const db = database();
  const stamp = iso(now);
  const links = db.deleteBefore('access_outside_links', 'expires_at', stamp);
  const used = db.all<{ id: string }>('SELECT id FROM access_outside_links WHERE used_at IS NOT NULL').map((link) => db.delete('access_outside_links', { id: link.id })).reduce((a, b) => a + b, 0);
  return { links: links + used, sessions: pruneSessions(now) };
}
