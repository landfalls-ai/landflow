/**
 * Access requests (docs/access-requests.md#asking).
 *
 * GET  /api/access/requests?scope=mine|decide|all&status=&limit=&cursor= → `{ items, nextCursor?, setup }`, newest first. `mine`: the caller's;
 *   `decide`: the waiting ones they decide; `all`: everything they may see (admins: every request).
 * POST /api/access/requests `{ entryId, durationMinutes, reason, account? }` → 201 the request. The requester is the signed-in user, never
 *   a field. 400 for a duration the entry does not offer or a reason outside 3 to 500 characters; 404 for an entry the caller may not see;
 *   409 when access requests are not set up, a request or a grant already exists (`existingId`), or nobody but the requester can approve.
 */
import { z } from 'zod';
import { createRequest, listRequests } from '@/lib/server/access/requests';
import { accessSetup } from '@/lib/server/access/setup';
import { handler, json, parseBody, parseQuery } from '@/lib/server/http';
import { pageSchema } from '@/lib/server/pagination';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

const querySchema = pageSchema.extend({
  scope: z.enum(['mine', 'decide', 'all']).default('mine'),
  status: z.enum(['pending', 'approved', 'denied', 'expired', 'cancelled', 'failed']).optional(),
});
const bodySchema = z.object({ entryId: z.string().min(1).max(100), durationMinutes: z.number().int().nullable(), reason: z.string().max(2000), account: z.string().max(100).optional() });

export const GET = handler(async (request: Request) => {
  const query = parseQuery(request, querySchema);
  if (!query.ok) return query.response;
  const page = listRequests(routeActor(), { scope: query.data.scope, limit: query.data.limit, ...(query.data.status && { status: query.data.status }), ...(query.data.cursor && { cursor: query.data.cursor }) });
  return json({ ...page, setup: accessSetup() });
});

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  return json(await createRequest(routeActor(), { ...body.data, channel: 'form' }), 201);
});
