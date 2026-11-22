/**
 * Personal API keys: `lf_` and 32 random bytes (base64url), shown once and kept as their SHA-256 in `api_keys`
 * with a label, scopes and an optional expiry. Sent as `Authorization: Bearer lf_…` or `X-Landflow-API-Key`.
 * A key acts as its user, limited to its scopes: the role checks and project access still apply. Keys of a
 * deactivated user don't work. The `scim` scope is for identity providers (lib/server/scim) and grants nothing else.
 */
import { nanoid } from 'nanoid';
import { API_KEY_SCOPES, can, type ApiKeyScope, type ApiKeyView } from '../../shared/auth';
import { API_KEY_PREFIX } from '../../shared/auth-paths';
import { allowed } from '../net/ip-allow';
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
  allowed_ips?: string | null;
  max_uses?: number | null;
  last_used_ip?: string | null;
}

/** A key as stored: `uses` is not here (it is counted in api_key_uses, ./api-key-uses, and joined into the view). */
export interface ApiKeyRecord extends Omit<ApiKeyView, 'uses' | 'usedUp'> {
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
    ...(row.last_used_ip && { lastUsedIp: row.last_used_ip }),
    ...(parseList(row.allowed_ips).length && { allowedIps: parseList(row.allowed_ips) }),
    ...(row.max_uses && { maxUses: Number(row.max_uses) }),
  };
}

function parseList(text: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(text ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

/** The key as the API shows it; `uses` (api-key-uses.ts) makes the count and "used up" part of it. */
export function apiKeyView(key: ApiKeyRecord, uses?: number): ApiKeyView {
  const { userId: _userId, ...view } = key;
  if (!key.maxUses || uses === undefined) return view;
  return { ...view, uses, usedUp: uses >= key.maxUses };
}

/**
 * Why `user` may not create a key with `scopes`, or undefined when they may. Everyone makes keys with the brain and
 * workflow scopes their role has (members build and run workflows, so they have `workflows:*`, `executions:*` and
 * `run`); the `admin` scope and SCIM tokens (the `scim` scope, alone) are for owners and admins.
 */
export function scopeRefusal(user: { role: UserRecord['role'] }, scopes: readonly ApiKeyScope[]): { reason: string; status: 400 | 403 } | undefined {
  if (scopes.includes('admin') && !can(user, 'apiKeys:admin')) return { reason: 'Only owners and admins can create keys with the admin scope', status: 403 };
  if (scopes.includes('scim') && !can(user, 'scim:manage')) return { reason: 'Only owners and admins can create SCIM tokens', status: 403 };
  if (scopes.includes('scim') && scopes.length > 1) return { reason: 'A SCIM token has the scim scope only', status: 400 };
  return undefined;
}

/** A new key (`lf_…`, never `lf_mcp_…`, which is the instance MCP token's prefix). */
function newKey(): string {
  for (;;) {
    const secret = randomToken(32);
    if (!secret.startsWith('mcp_')) return `${API_KEY_PREFIX}${secret}`;
  }
}

/** Create a key for `user`; the result's `token` is the key, shown once. */
export function createApiKey(
  user: UserRecord,
  input: { label: string; scopes: ApiKeyScope[]; expiresAt?: string; /** Already checked (checkAllowList). */ allowedIps?: string[]; maxUses?: number },
): { key: ApiKeyRecord; token: string } {
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
    allowed_ips: input.allowedIps?.length ? JSON.stringify(input.allowedIps) : null,
    max_uses: input.maxUses ?? null,
    last_used_ip: null,
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
  const db = authDb();
  // The count goes with the key (a leftover row would only be dead weight: ids are never reused).
  return db.transaction(() => {
    db.delete('api_key_uses', { key_id: id });
    return db.delete('api_keys', { id }) > 0;
  });
}

/** `key` is set when the key is known but refused (an address outside its list), for the audit row. */
export type ApiKeyCheck =
  | { ok: true; key: ApiKeyRecord; user: UserRecord }
  | { ok: false; reason: 'unknown' | 'expired' }
  | { ok: false; reason: 'ip_not_allowed'; key: ApiKeyRecord };

/**
 * Look a key up: its record and user when it exists, hasn't expired and the caller's address (`ip`, from callerIp) is on
 * its allow-list. Free of side effects but the last-used touch: the use cap is counted apart (./api-key-uses), after the
 * guard, so that the audit layer's second look at a refused request never counts.
 */
export function verifyApiKey(token: string, options: { now?: number; ip?: string } = {}): ApiKeyCheck {
  const now = options.now ?? Date.now();
  if (!token.startsWith(API_KEY_PREFIX) || token.length > 200) return { ok: false, reason: 'unknown' };
  const db = authDb();
  const row = db.get<ApiKeyRow>('SELECT * FROM api_keys WHERE key_hash = ?', tokenHash(token));
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.expires_at && Date.parse(row.expires_at) <= now) return { ok: false, reason: 'expired' };
  const user = getUser(row.user_id);
  if (!user || user.disabledAt) return { ok: false, reason: 'unknown' };
  const list = parseList(row.allowed_ips);
  if (!allowed(options.ip, list)) return { ok: false, reason: 'ip_not_allowed', key: fromRow(row) };
  const touched = singleton('api-key-touched', () => new Map<string, number>());
  if (now - (touched.get(row.id) ?? 0) > TOUCH_EVERY_MS) {
    touched.set(row.id, now);
    // The whole row is rewritten: nothing the use count needs lives in it.
    db.upsert('api_keys', { ...row, last_used_at: new Date(now).toISOString(), ...(options.ip && { last_used_ip: options.ip }) });
  }
  return { ok: true, key: fromRow(row), user };
}
