/**
 * Your API keys (session only: an API key can't make keys). GET lists them; POST { label, scopes, expiresInDays? }
 * creates one and returns it once as `token` (`lf_…`, sent as `Authorization: Bearer lf_…`). Only owners and admins
 * create keys with the `admin` scope, and SCIM tokens (the `scim` scope alone, made in Settings → Security); every
 * other scope (the brain's and the workflow ones) is open to every role, as the role's own routes still apply (`scopeRefusal`).
 */
import { z } from 'zod';
import { API_KEY_SCOPES } from '@/lib/shared/auth';
import { apiKeyView, createApiKey, listApiKeys, requireUser } from '@/lib/server/auth';
import { scopeRefusal } from '@/lib/server/auth/api-keys';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { auditedTransaction, recordAudit } from '@/lib/server/audit';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const me = await requireUser();
  return json({ keys: listApiKeys(me.id).map(apiKeyView) });
});

const schema = z.object({
  label: z.string().trim().min(1, 'Name the key').max(100),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1, 'Pick at least one scope'),
  /** Days until it stops working; none = never. */
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});

export const POST = handler(async (request: Request) => {
  const me = await requireUser();
  const body = await parseBody(request, schema);
  if (!body.ok) return body.response;
  // The admin scope and SCIM tokens (Settings → Security) are for owners and admins; everything else is the role's own.
  const refusal = scopeRefusal(me, body.data.scopes);
  if (refusal) return error(refusal.reason, refusal.status);
  const expiresAt = body.data.expiresInDays ? new Date(Date.now() + body.data.expiresInDays * 86_400_000).toISOString() : undefined;
  // One transaction with its event: with LANDFLOW_AUDIT_FAIL_CLOSED a key whose event can't be stored is not created.
  const { key, token } = auditedTransaction(() => {
    const created = createApiKey(me, { label: body.data.label, scopes: body.data.scopes, ...(expiresAt && { expiresAt }) });
    const { key } = created;
    recordAudit({ action: 'api_key.create', target: { type: 'api_key', id: key.id, name: key.label }, summary: `Created the API key “${key.label}” (${key.scopes.join(', ')})`, details: { scopes: key.scopes, expiresAt: key.expiresAt } });
    return created;
  });
  return json({ key: apiKeyView(key), token }, 201);
});
