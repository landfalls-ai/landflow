/**
 * The rows of people without a Landflow account (migration 2936): requesters, their one-time email links and their sessions. Tokens
 * are only ever kept as SHA-256. The one thing that must be decided by the database is a link's single use: `claimLink` is one
 * conditional update (SQLite inside its transaction, Postgres through `db.direct` with this process's copy following), so two clicks
 * on one link, in this process or in two, log in once. Plain server module: no Next.js import.
 */
import { listUsers, type UserRecord } from '../../auth/users';
import { database, type Database } from '../../db';
import type { Row } from '../../db/database';
import type { OutsideRequester } from './identity';

export interface RequesterRow {
  id: string;
  email: string;
  email_key: string;
  name: string | null;
  verified_by: 'link' | 'google';
  google_subject: string | null;
  created_at: string;
  last_verified_at: string;
  last_seen_at: string | null;
  blocked_at: string | null;
  blocked_by: string | null;
}

export interface LinkRow {
  id: string;
  token_hash: string;
  email_key: string;
  email: string;
  ip: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

export interface SessionRow {
  id: string;
  token_hash: string;
  requester_id: string;
  method: 'link' | 'google';
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  ip: string | null;
  user_agent: string | null;
}

/** The address as it is compared: lower case, trimmed, the local part cut at the first `+`. Two spellings of one inbox never make two people. */
export function canonicalEmail(email: string): string {
  const [local = '', ...rest] = email.trim().toLowerCase().split('@');
  const domain = rest.join('@');
  return `${local.split('+')[0]}@${domain}`;
}

/** Whether the address has a `+tag` (refused for outside requesters: `bob+x@` can't stand beside `bob@`). */
export const hasSubaddress = (email: string): boolean => (email.trim().split('@')[0] ?? '').includes('+');

/** The Landflow user (active or disabled) whose address is this one, compared on its canonical form. */
export function landflowUserWithEmail(email: string): UserRecord | undefined {
  const key = canonicalEmail(email);
  return listUsers().find((user) => canonicalEmail(user.email) === key);
}

/** A requester row as the rest of Landflow sees it (no google subject, no timestamps). */
export const toRequester = (row: RequesterRow): OutsideRequester => ({ id: row.id, email: row.email, name: row.name, verifiedBy: row.verified_by, blocked: Boolean(row.blocked_at) });

// ---- requesters -------------------------------------------------------------------------------------------

export const requesterRow = (id: string): RequesterRow | undefined => database().get<RequesterRow>('SELECT * FROM access_outside_requesters WHERE id = ?', id);
export const requesterRowByKey = (emailKey: string): RequesterRow | undefined => database().get<RequesterRow>('SELECT * FROM access_outside_requesters WHERE email_key = ?', emailKey);
export const requesterRows = (): RequesterRow[] => database().all<RequesterRow>('SELECT * FROM access_outside_requesters ORDER BY COALESCE(last_seen_at, last_verified_at) DESC, id');
export const saveRequester = (row: RequesterRow) => database().upsert('access_outside_requesters', row as unknown as Row);

// ---- links ------------------------------------------------------------------------------------------------

export const insertLink = (row: LinkRow) => database().insertNew('access_outside_links', row as unknown as Row);
/** An address has at most one live link: a new one replaces the older. */
export const deleteOpenLinks = (emailKey: string) => database().all<{ id: string }>('SELECT id FROM access_outside_links WHERE email_key = ? AND used_at IS NULL', emailKey).forEach((link) => database().delete('access_outside_links', { id: link.id }));

/** The link of `tokenHash` if it is still usable (read only: peeking never uses it up). */
export const usableLink = (tokenHash: string, now: number): LinkRow | undefined => {
  const row = database().get<LinkRow>('SELECT * FROM access_outside_links WHERE token_hash = ?', tokenHash);
  return row && !row.used_at && row.expires_at > new Date(now).toISOString() ? row : undefined;
};

/** Take what Postgres decided into this process's copy. */
async function adopt(handle: Database, table: 'access_outside_links', id: string, row: Row): Promise<void> {
  if (await handle.refresh(table, { id })) return;
  handle.upsertLocal(table, row);
}

/**
 * Use up the link of `tokenHash` if it exists, is unused and has not expired: one conditional update, never a read followed by a write.
 * Returns the link when this call used it, undefined for every other outcome (unknown, used, expired, lost the race). `handle` is for
 * tests (two processes' databases).
 */
export async function claimLink(tokenHash: string, now: number, handle: Database = database()): Promise<LinkRow | undefined> {
  const stamp = new Date(now).toISOString();
  if (handle.kind !== 'postgres') {
    return handle.transaction(() => {
      const row = handle.get<LinkRow>('SELECT * FROM access_outside_links WHERE token_hash = ?', tokenHash);
      if (!row || row.used_at || row.expires_at <= stamp) return undefined;
      const used = { ...row, used_at: stamp };
      handle.upsert('access_outside_links', used as unknown as Row);
      return used;
    });
  }
  // A link just inserted must be in Postgres before a conditional update looks for it.
  await handle.flush();
  const result = await handle.direct(async (client) => {
    const updated = await client.query<LinkRow>('UPDATE access_outside_links SET used_at = $1 WHERE token_hash = $2 AND used_at IS NULL AND expires_at > $1 RETURNING *', [stamp, tokenHash]);
    if (updated.rows[0]) {
      const payload = handle.keyNotice('access_outside_links', [updated.rows[0].id]);
      if (payload) await client.query('SELECT pg_notify($1, $2)', ['landflow_changes', payload]);
    }
    return updated;
  });
  const won = result?.rows[0];
  if (!won) return undefined;
  await adopt(handle, 'access_outside_links', won.id, won as unknown as Row);
  return won;
}

// ---- sessions ---------------------------------------------------------------------------------------------

export const insertSession = (row: SessionRow) => database().insertNew('access_outside_sessions', row as unknown as Row);
export const sessionRowByHash = (tokenHash: string): SessionRow | undefined => database().get<SessionRow>('SELECT * FROM access_outside_sessions WHERE token_hash = ?', tokenHash);
export const sessionsOf = (requesterId: string): SessionRow[] => database().all<SessionRow>('SELECT * FROM access_outside_sessions WHERE requester_id = ? ORDER BY created_at', requesterId);
export const touchSession = (row: SessionRow, lastSeenAt: string) => database().upsert('access_outside_sessions', { ...row, last_seen_at: lastSeenAt } as unknown as Row);
export const deleteSessionRow = (id: string) => database().delete('access_outside_sessions', { id });
export const deleteSessionRowsOf = (requesterId: string) => database().delete('access_outside_sessions', { requester_id: requesterId });
