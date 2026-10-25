/**
 * Your API keys (session only: an API key can't make keys). GET lists them; POST { label, scopes, expiresInDays? }
 * creates one and returns it once as `token` (`lf_…`, sent as `Authorization: Bearer lf_…`). Only owners and admins
 * create keys with the `admin` scope.
 */
import { z } from 'zod';
import { API_KEY_SCOPES, can } from '@/lib/shared/auth';
import { apiKeyView, createApiKey, listApiKeys, requireUser } from '@/lib/server/auth';
import { error, handler, json, parseBody } from '@/lib/server/http';

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
  if (body.data.scopes.includes('admin') && !can(me, 'apiKeys:admin')) return error('Only owners and admins can create keys with the admin scope', 403);
  const expiresAt = body.data.expiresInDays ? new Date(Date.now() + body.data.expiresInDays * 86_400_000).toISOString() : undefined;
  const { key, token } = createApiKey(me, { label: body.data.label, scopes: body.data.scopes, ...(expiresAt && { expiresAt }) });
  return json({ key: apiKeyView(key), token }, 201);
});
