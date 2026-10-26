/**
 * SAML state every main shares, in the `saml_state` table (migration 1501): sign-ins in flight (`relay`: RelayState →
 * where to go after), the AuthnRequest and LogoutRequest ids a response's InResponseTo must match (`request`, one use)
 * and the NameID and SessionIndex of SAML sessions, by the session token's hash, for single logout (`session`). So a
 * sign-in can start on one main and finish on another, a logout reach any of them, and a restart forgets nothing.
 * Every row expires (`expires_at`); expired ones are never returned and are swept as new ones are written.
 *
 * SQLite (one process, or several sharing the file): a one-use take reads and deletes in one transaction (BEGIN
 * IMMEDIATE, so two processes can't both get the row). Postgres: rows are written through the in-memory copy like any
 * other and flushed before the browser leaves for the IdP; reads use the copy and, on a miss (another main wrote it a
 * moment ago), Postgres; a take is one `DELETE … RETURNING` on Postgres, so of two mains given the same response only
 * one gets the id. The same goes for the replay ids in `saml_replay` (`recordReplayIds`).
 */
import type { Database, DirectClient, SqlValue } from '../db';
import { CHANGES_CHANNEL, noticesFor } from '../db/replication';
import { authDb } from './db';

export type SamlStateKind = 'relay' | 'request' | 'session';

interface StateRow {
  value: string;
  expires_at: string;
}

const iso = (ms: number) => new Date(ms).toISOString();
const live = (row: StateRow | undefined, now: number) => (row && Date.parse(row.expires_at) > now ? row.value : undefined);

/** Deletes made straight on Postgres reach every process's copy (this one's too: no process has this origin). */
async function announceDelete(client: DirectClient, where: Record<string, SqlValue>) {
  for (const payload of noticesFor('saml-state', [{ op: 'delete', table: 'saml_state', where }])) await client.query('SELECT pg_notify($1, $2)', [CHANGES_CHANNEL, payload]);
}

/** Keep `value` under (`kind`, `id`) for `ttlMs` (replacing what was there). */
export async function putState(kind: SamlStateKind, id: string, value: string, ttlMs: number, userId?: string, now = Date.now(), db: Database = authDb()): Promise<void> {
  db.transaction(() => {
    db.deleteBefore('saml_state', 'expires_at', iso(now));
    db.upsert('saml_state', { kind, id, value, user_id: userId ?? null, created_at: iso(now), expires_at: iso(now + ttlMs) });
  });
  // Postgres: in Postgres before the browser can reach another main.
  if (db.kind === 'postgres') await db.flush();
}

/** The live value under (`kind`, `id`), if any. */
export async function readState(kind: SamlStateKind, id: string, now = Date.now(), db: Database = authDb()): Promise<string | undefined> {
  if (!id) return undefined;
  const local = live(db.get<StateRow>('SELECT value, expires_at FROM saml_state WHERE kind = ? AND id = ?', kind, id), now);
  if (local !== undefined || db.kind !== 'postgres') return local;
  const result = await db.direct((client) => client.query<StateRow>('SELECT value, expires_at FROM saml_state WHERE kind = $1 AND id = $2', [kind, id]));
  return live(result?.rows[0], now);
}

/** Remove (`kind`, `id`) and return its value when it was there and live: of several callers, only one gets it. */
export async function takeState(kind: SamlStateKind, id: string, now = Date.now(), db: Database = authDb()): Promise<string | undefined> {
  if (!id) return undefined;
  if (db.kind !== 'postgres') {
    return db.transaction(() => {
      const row = db.get<StateRow>('SELECT value, expires_at FROM saml_state WHERE kind = ? AND id = ?', kind, id);
      if (row) db.delete('saml_state', { kind, id });
      return live(row, now);
    });
  }
  // Our own writes of this row first, then the one decision that counts.
  await db.flush();
  const result = await db.direct(async (client) => {
    const deleted = await client.query<StateRow>('DELETE FROM saml_state WHERE kind = $1 AND id = $2 RETURNING value, expires_at', [kind, id]);
    if (deleted.rowCount) await announceDelete(client, { kind, id });
    return deleted;
  });
  // This copy at once (the notice repeats it).
  db.delete('saml_state', { kind, id });
  return live(result?.rows[0], now);
}

/** Forget every row of `kind` that belongs to `userId` (an IdP-initiated logout ends all of a user's sessions). */
export async function dropUserStates(kind: SamlStateKind, userId: string, db: Database = authDb()): Promise<void> {
  if (db.kind === 'postgres') {
    await db.flush();
    await db.direct(async (client) => {
      const deleted = await client.query('DELETE FROM saml_state WHERE kind = $1 AND user_id = $2', [kind, userId]);
      if (deleted.rowCount) await announceDelete(client, { kind, user_id: userId });
    });
  }
  db.delete('saml_state', { kind, user_id: userId });
}

/**
 * Record replay ids (`saml_replay`) until `expiresAt`; throws `replayed()` when one is already there and live. On
 * Postgres the insert is decided there (expired rows are taken over), in one transaction for all the ids.
 */
export async function recordReplayIds(ids: string[], expiresAt: number, replayed: () => Error, now = Date.now(), db: Database = authDb()): Promise<void> {
  if (db.kind === 'postgres') {
    await db.flush();
    const fresh = await db.direct(async (client) => {
      await client.query('BEGIN');
      try {
        for (const id of ids) {
          const inserted = await client.query(
            'INSERT INTO saml_replay (id, expires_at) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET expires_at = excluded.expires_at WHERE saml_replay.expires_at <= $3 RETURNING id',
            [id, iso(expiresAt), iso(now)],
          );
          if (!inserted.rowCount) {
            await client.query('ROLLBACK');
            return false;
          }
        }
        await client.query('COMMIT');
        return true;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    });
    if (!fresh) throw replayed();
    // The copy, for the quick check before validating (and other mains' copies).
    db.transaction(() => {
      db.deleteBefore('saml_replay', 'expires_at', iso(now));
      for (const id of ids) db.upsert('saml_replay', { id, expires_at: iso(expiresAt) });
    });
    return;
  }
  db.transaction(() => {
    db.deleteBefore('saml_replay', 'expires_at', iso(now));
    for (const id of ids) if (!db.insertNew('saml_replay', { id, expires_at: iso(expiresAt) })) throw replayed();
  });
}

/** Tests: forget every SAML state row. */
export function clearSamlState() {
  authDb().deleteBefore('saml_state', 'expires_at', '9999-12-31T23:59:59.999Z');
}
