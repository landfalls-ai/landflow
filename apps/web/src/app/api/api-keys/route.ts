/**
 * Your API keys (session only: an API key can't make keys). GET lists them; POST { label, scopes, expiresInDays?,
 * allowedIps?, maxUses? } (an allow-list and a use cap, fixed at creation: changing them means a new key)
 * creates one and returns it once as `token` (`lf_…`, sent as `Authorization: Bearer lf_…`). Only owners and admins
 * create keys with the `admin` scope, and SCIM tokens (the `scim` scope alone, made in Settings → Security); every
 * other scope (the brain's and the workflow ones) is open to every role, as the role's own routes still apply (`scopeRefusal`).
 */
import { z } from 'zod';
import { API_KEY_SCOPES } from '@/lib/shared/auth';
import { apiKeyView, createApiKey, listApiKeys, requireUser } from '@/lib/server/auth';
import { scopeRefusal } from '@/lib/server/auth/api-keys';
import { apiKeyUses } from '@/lib/server/auth/api-key-uses';
import { checkAllowList } from '@/lib/server/net/ip-allow';
import { trustedProxies, trustedProxiesConfigured } from '@/lib/server/net/client-address';
import { isProduction } from '@/lib/server/config';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { auditedTransaction, recordAudit } from '@/lib/server/audit';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const me = await requireUser();
  const keys = listApiKeys(me.id);
  // The uses are read where the count is decided (Postgres in queue mode), not from this process's copy.
  const counts = await apiKeyUses(keys.filter((key) => key.maxUses).map((key) => key.id));
  // `addressUnverified`: no trusted proxy is configured, so a caller may write its own X-Forwarded-For and an allow-list can be got around (the form warns).
  return json({ keys: keys.map((key) => apiKeyView(key, counts.get(key.id))), addressUnverified: trustedProxies() === 0 });
});

const schema = z.object({
  label: z.string().trim().min(1, 'Name the key').max(100),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1, 'Pick at least one scope'),
  /** Days until it stops working; none = never. */
  expiresInDays: z.number().int().min(1).max(3650).optional(),
  /** Addresses and CIDR ranges the key works from (none = anywhere); fixed at creation. Each entry is checked (checkAllowList). */
  allowedIps: z.array(z.string().max(100)).max(500).optional(),
  /** The key stops working after this many uses (none = no cap); fixed at creation. */
  maxUses: z.number().int().min(1).max(1_000_000).optional(),
});

export const POST = handler(async (request: Request) => {
  const me = await requireUser();
  const body = await parseBody(request, schema);
  if (!body.ok) return body.response;
  // The admin scope and SCIM tokens (Settings → Security) are for owners and admins; everything else is the role's own.
  const refusal = scopeRefusal(me, body.data.scopes);
  if (refusal) return error(refusal.reason, refusal.status);
  const list = body.data.allowedIps?.length ? checkAllowList(body.data.allowedIps) : undefined;
  if (list && !list.ok) return error(list.problem, 400);
  // In production an allow-list needs LANDFLOW_TRUSTED_PROXIES set on purpose (even to 0 for direct clients): without it the caller's own
  // X-Forwarded-For decides the address and the list protects nothing.
  if (list?.ok && isProduction() && !trustedProxiesConfigured()) {
    return error('An address list can’t be trusted until LANDFLOW_TRUSTED_PROXIES says how many reverse proxies sit in front of Landflow: set it (0 when clients connect directly), then create the key', 400);
  }
  const expiresAt = body.data.expiresInDays ? new Date(Date.now() + body.data.expiresInDays * 86_400_000).toISOString() : undefined;
  // One transaction with its event: with LANDFLOW_AUDIT_FAIL_CLOSED a key whose event can't be stored is not created.
  const { key, token } = auditedTransaction(() => {
    const created = createApiKey(me, { label: body.data.label, scopes: body.data.scopes, ...(expiresAt && { expiresAt }), ...(list?.ok && { allowedIps: list.entries }), ...(body.data.maxUses && { maxUses: body.data.maxUses }) });
    const { key } = created;
    recordAudit({ action: 'api_key.create', target: { type: 'api_key', id: key.id, name: key.label }, summary: `Created the API key “${key.label}” (${key.scopes.join(', ')})`, details: { scopes: key.scopes, expiresAt: key.expiresAt, allowedIps: key.allowedIps, maxUses: key.maxUses } });
    return created;
  });
  return json({ key: apiKeyView(key, 0), token }, 201);
});
