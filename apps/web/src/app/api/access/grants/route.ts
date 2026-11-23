/**
 * GET /api/access/grants?scope=mine|all&status= → `{ items }`: the caller's own grants (`mine`), or every grant they may see (`all`: the holder's,
 * and for owners, approvers and admins the entry's). A grant 24 h past its end and still in place has an `access.grant.revoke_overdue` audit event.
 */
import { z } from 'zod';
import { listGrants } from '@/lib/server/access/grants';
import { handler, json, parseQuery } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  scope: z.enum(['mine', 'all']).default('mine'),
  status: z.enum(['pending', 'active', 'removing', 'expired', 'revoked', 'failed', 'revoke_failed', 'drift']).optional(),
});

export const GET = handler(async (request: Request) => {
  const query = parseQuery(request, querySchema);
  if (!query.ok) return query.response;
  return json({ items: listGrants(routeActor(), { scope: query.data.scope, ...(query.data.status && { status: query.data.status }) }) });
});
