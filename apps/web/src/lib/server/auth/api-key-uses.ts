/**
 * The use count of a capped API key, exact across processes. It lives in `api_key_uses` (not on the key's row: the
 * last-used touch rewrites that whole row from this process's copy and would overwrite a count) and is moved by one
 * conditional statement decided where the data is shared: in Postgres mode `INSERT … ON CONFLICT DO UPDATE … WHERE uses <
 * cap RETURNING`, so two processes never both take the last use; on SQLite one `BEGIN IMMEDIATE` transaction (read,
 * compare, write), which serializes writers across processes sharing the file. A key without a cap makes no write at all.
 */
import type { Database } from '../db';
import type { ApiKeyRecord } from './api-keys';
import { authDb } from './db';

export type UseResult = { ok: true; uses?: number } | { ok: false; reason: 'uses_exhausted' };

/**
 * Count one use of `key`: ok while the count stays within `maxUses`, `uses_exhausted` for the call that would pass it
 * (the count never goes above the cap). `handle` is for tests (a second process's database).
 */
export async function consumeApiKeyUse(key: Pick<ApiKeyRecord, 'id'> & { maxUses?: number }, handle: Database = authDb()): Promise<UseResult> {
  const cap = key.maxUses;
  if (!cap) return { ok: true };
  const at = new Date().toISOString();
  if (handle.kind === 'postgres') {
    const result = await handle.direct((client) =>
      client.query<{ uses: string | number }>(
        `INSERT INTO api_key_uses (key_id, uses, updated_at) VALUES ($1, 1, $3)
         ON CONFLICT (key_id) DO UPDATE SET uses = api_key_uses.uses + 1, updated_at = $3 WHERE api_key_uses.uses < $2
         RETURNING uses`,
        [key.id, cap, at],
      ),
    );
    // No connection to decide on: an error (the caller answers 5xx), never a quiet "used up".
    if (!result) throw new Error('The API key use count could not be decided: no Postgres connection');
    const row = result.rows[0];
    if (!row) return { ok: false, reason: 'uses_exhausted' };
    const uses = Number(row.uses);
    // This process's copy follows (nothing is queued: Postgres already holds the number).
    handle.upsertLocal('api_key_uses', { key_id: key.id, uses, updated_at: at });
    return { ok: true, uses };
  }
  return handle.transaction(() => {
    const used = Number(handle.get<{ uses: number }>('SELECT uses FROM api_key_uses WHERE key_id = ?', key.id)?.uses ?? 0);
    if (used >= cap) return { ok: false, reason: 'uses_exhausted' } as const;
    handle.upsert('api_key_uses', { key_id: key.id, uses: used + 1, updated_at: at });
    return { ok: true, uses: used + 1 } as const;
  });
}

/**
 * The uses of `keyIds` as of now: in Postgres mode read there (another process may have counted since this one's copy
 * was written), else from the database. Keys never used are absent.
 */
export async function apiKeyUses(keyIds: string[], handle: Database = authDb()): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!keyIds.length) return counts;
  const fresh =
    handle.kind === 'postgres'
      ? (await handle.direct((client) => client.query<{ key_id: string; uses: string | number }>('SELECT key_id, uses FROM api_key_uses WHERE key_id = ANY($1)', [keyIds])))?.rows
      : undefined;
  const rows = fresh ?? keyIds.flatMap((id) => handle.all<{ key_id: string; uses: number }>('SELECT key_id, uses FROM api_key_uses WHERE key_id = ?', id));
  for (const row of rows) counts.set(row.key_id, Number(row.uses));
  return counts;
}
