/**
 * Requests for a higher AI cap (docs/llm-gateway.md#asking-for-a-higher-cap).
 *
 * GET  /api/ai/cap-requests?status=&limit=&cursor= → `{ items, nextCursor?, setup }`: admins see every request, others their own.
 * POST /api/ai/cap-requests `{ capId, requested, reason }` → 201 the request. 409 when the cap-raise flow is off or the
 * caller already has an open request for the cap; 400 for a cap the caller may not ask about.
 */
import { z } from 'zod';
import { capRaiseSetup, createCapRequest, listCapRequests } from '@/lib/server/llm-gateway/cap-requests';
import { handler, json, parseBody, parseQuery } from '@/lib/server/http';
import { pageSchema } from '@/lib/server/pagination';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

const querySchema = pageSchema.extend({ status: z.enum(['pending', 'asking', 'approved', 'rejected', 'failed', 'cancelled']).optional() });
const bodySchema = z.object({ capId: z.string().min(1).max(300), requested: z.number().finite().positive().max(1e12), reason: z.string().max(2000) });

export const GET = handler(async (request: Request) => {
  const query = parseQuery(request, querySchema);
  if (!query.ok) return query.response;
  const page = listCapRequests(routeActor(), { limit: query.data.limit, ...(query.data.status && { status: query.data.status }), ...(query.data.cursor && { cursor: query.data.cursor }) });
  return json({ ...page, setup: capRaiseSetup() });
});

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  return json(await createCapRequest(routeActor(), body.data), 201);
});
