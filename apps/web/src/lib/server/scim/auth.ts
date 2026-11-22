/**
 * SCIM authentication: `Authorization: Bearer lf_…`, an API key with the `scim` scope (created in Settings →
 * Security). The scope must be on the key itself (an `admin` key is not a SCIM token), and the key's user must be an
 * owner or admin who isn't deactivated (verifyApiKey refuses deactivated users' keys).
 */
import { can, type ApiKeyScope } from '../../shared/auth';
import { API_KEY_PREFIX } from '../../shared/auth-paths';
import { KEY_REFUSAL_MESSAGE } from '../auth/api-key-refusal';
import { verifyApiKey } from '../auth/api-keys';
import { callerIp } from '../net/ip-allow';
import type { UserRecord } from '../auth/users';

export interface ScimCaller {
  user: UserRecord;
  keyId: string;
  scopes: ApiKeyScope[];
  label?: string;
  /** The token's use cap: counted after the check (scimRoute). */
  maxUses?: number;
}

/** A 403 names the key and its user: the token was valid, only not enough. */
export type ScimAuth =
  | { ok: true; caller: ScimCaller }
  | { ok: false; status: 401 | 403; message: string; keyId?: string; userId?: string; /** An address refusal: the token is known (the audit row names it). */ refused?: { id: string; label: string } };

export function authenticateScim(request: Request): ScimAuth {
  const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization')?.trim() ?? '')?.[1];
  if (!token || !token.startsWith(API_KEY_PREFIX)) return { ok: false, status: 401, message: 'Send a SCIM token as Authorization: Bearer lf_… (Settings → Security → SCIM)' };
  const checked = verifyApiKey(token, { ip: callerIp(request) });
  if (!checked.ok && checked.reason === 'ip_not_allowed') return { ok: false, status: 401, message: KEY_REFUSAL_MESSAGE.ip_not_allowed, refused: { id: checked.key.id, label: checked.key.label } };
  if (!checked.ok) return { ok: false, status: 401, message: checked.reason === 'expired' ? 'This SCIM token has expired' : 'Invalid SCIM token' };
  const known = { keyId: checked.key.id, userId: checked.user.id };
  if (!checked.key.scopes.includes('scim')) return { ok: false, status: 403, message: 'This API key lacks the “scim” scope: create a SCIM token in Settings → Security', ...known };
  if (!can(checked.user, 'scim:manage')) return { ok: false, status: 403, message: 'SCIM tokens must belong to an owner or admin', ...known };
  return { ok: true, caller: { user: checked.user, keyId: checked.key.id, scopes: checked.key.scopes, label: checked.key.label, ...(checked.key.maxUses && { maxUses: checked.key.maxUses }) } };
}
