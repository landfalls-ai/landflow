/**
 * SCIM authentication: `Authorization: Bearer lf_…`, an API key with the `scim` scope (created in Settings →
 * Security). The scope must be on the key itself (an `admin` key is not a SCIM token), and the key's user must be an
 * owner or admin who isn't deactivated (verifyApiKey refuses deactivated users' keys).
 */
import { can, type ApiKeyScope } from '../../shared/auth';
import { API_KEY_PREFIX } from '../../shared/auth-paths';
import { verifyApiKey } from '../auth/api-keys';
import type { UserRecord } from '../auth/users';

export interface ScimCaller {
  user: UserRecord;
  keyId: string;
  scopes: ApiKeyScope[];
}

export type ScimAuth = { ok: true; caller: ScimCaller } | { ok: false; status: 401 | 403; message: string };

export function authenticateScim(request: Request): ScimAuth {
  const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization')?.trim() ?? '')?.[1];
  if (!token || !token.startsWith(API_KEY_PREFIX)) return { ok: false, status: 401, message: 'Send a SCIM token as Authorization: Bearer lf_… (Settings → Security → SCIM)' };
  const checked = verifyApiKey(token);
  if (!checked.ok) return { ok: false, status: 401, message: checked.reason === 'expired' ? 'This SCIM token has expired' : 'Invalid SCIM token' };
  if (!checked.key.scopes.includes('scim')) return { ok: false, status: 403, message: 'This API key lacks the “scim” scope: create a SCIM token in Settings → Security' };
  if (!can(checked.user, 'scim:manage')) return { ok: false, status: 403, message: 'SCIM tokens must belong to an owner or admin' };
  return { ok: true, caller: { user: checked.user, keyId: checked.key.id, scopes: checked.key.scopes } };
}
