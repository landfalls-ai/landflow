/**
 * Personal API keys: `lf_` and 32 random bytes (base64url), shown once and kept as their SHA-256 in `api_keys`
 * with a label, scopes and an optional expiry. Sent as `Authorization: Bearer lf_…` or `X-Landflow-API-Key`.
 * A key acts as its user, limited to its scopes: the role checks and project access still apply. Keys of a
 * deactivated user don't work. The `scim` scope is for identity providers (lib/server/scim) and grants nothing else.
 */
import { nanoid } from 'nanoid';
import { API_KEY_SCOPES, type ApiKeyScope, type ApiKeyView } from '../../shared/auth';
import { API_KEY_PREFIX } from '../../shared/auth-paths';
import { singleton } from '../singleton';
import { authDb } from './db';
import { randomToken, tokenHash } from './passwords';
import { getUser, type UserRecord } from './users';

interface ApiKeyRow {
  id: string;
  user_id: string;
  label: string;
  key_hash: string;
  hint: string;
  scopes: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
}

export interface ApiKeyRecord extends ApiKeyView {
  userId: string;
}

/** last_used_at is written at most this often per key. */
const TOUCH_EVERY_MS = 60_000;

function parseScopes(text: string): ApiKeyScope[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed.filter((s): s is ApiKeyScope => (API_KEY_SCOPES as readonly string[]).includes(s)) : [];
  } catch {
    return [];
  }
}

function fromRow(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    userId: row.user_id,
    label: row.label,
    hint: row.hint,
    scopes: parseScopes(row.scopes),
    createdAt: row.created_at,
    ...(row.expires_at && { expiresAt: row.expires_at }),
    ...(row.last_used_at && { lastUsedAt: row.last_used_at }),
  };
}

export function apiKeyView(key: ApiKeyRecord): ApiKeyView {
  const { userId: _userId, ...view } = key;
  return view;
}

/** A new key (`lf_…`, never `lf_mcp_…`, which is the instance MCP token's prefix). */
function newKey(): string {
  for (;;) {
    const secret = randomToken(32);
    if (!secret.startsWith('mcp_')) return `${API_KEY_PREFIX}${secret}`;
  }
}

/** Create a key for `user`; the result's `token` is the key, shown once. */
export function createApiKey(user: UserRecord, input: { label: string; scopes: ApiKeyScope[]; expiresAt?: string }): { key: ApiKeyRecord; token: string } {
  const token = newKey();
  const row: ApiKeyRow = {
    id: `key_${nanoid(12)}`,
    user_id: user.id,
    label: input.label.trim().slice(0, 100) || 'API key',
    key_hash: tokenHash(token),
    hint: token.slice(-4),
    scopes: JSON.stringify([...new Set(input.scopes)]),
    created_at: new Date().toISOString(),
    expires_at: input.expiresAt ?? null,
    last_used_at: null,
  };
  authDb().insertNew('api_keys', { ...row });
  return { key: fromRow(row), token };
}

export function listApiKeys(userId: string): ApiKeyRecord[] {
  return authDb()
    .all<ApiKeyRow>('SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC', userId)
    .map(fromRow);
}

export function getApiKey(id: string): ApiKeyRecord | undefined {
  const row = authDb().get<ApiKeyRow>('SELECT * FROM api_keys WHERE id = ?', id);
  return row && fromRow(row);
}

export function deleteApiKey(id: string): boolean {
  return authDb().delete('api_keys', { id }) > 0;
}

export type ApiKeyCheck = { ok: true; key: ApiKeyRecord; user: UserRecord } | { ok: false; reason: 'unknown' | 'expired' };

/** Look a key up: its record and user when it exists and hasn't expired. */
export function verifyApiKey(token: string, now = Date.now()): ApiKeyCheck {
  if (!token.startsWith(API_KEY_PREFIX) || token.length > 200) return { ok: false, reason: 'unknown' };
  const db = authDb();
  const row = db.get<ApiKeyRow>('SELECT * FROM api_keys WHERE key_hash = ?', tokenHash(token));
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.expires_at && Date.parse(row.expires_at) <= now) return { ok: false, reason: 'expired' };
  const user = getUser(row.user_id);
  if (!user || user.disabledAt) return { ok: false, reason: 'unknown' };
  const touched = singleton('api-key-touched', () => new Map<string, number>());
  if (now - (touched.get(row.id) ?? 0) > TOUCH_EVERY_MS) {
    touched.set(row.id, now);
    db.upsert('api_keys', { ...row, last_used_at: new Date(now).toISOString() });
  }
  return { ok: true, key: fromRow(row), user };
}
