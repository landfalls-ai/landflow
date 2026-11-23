/**
 * POST /api/brain/work/:sourceId/share { visibility?: org|team }?source=<tool> — Post as my update: records a
 * `work.self_update` event the caller owns (shared with the organization by default, or the team) that links the item
 * (`attrs.of`). Posting the same item again updates that event. 404 when the caller has no such item. Needs the
 * `brain:write` scope (or a session); 503 when the brain is off.
 */
import { z } from 'zod';
import { shareWork } from '@/lib/server/brain/work';
import { error, handler, json, parseBody, parseQuery } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ sourceId: string }> };

const query = z.object({ source: z.string().min(1).max(40).optional() });
const body = z.object({ visibility: z.enum(['team', 'org']).optional() });

export const POST = handler(async (request: Request, ctx: Ctx) => {
  const { sourceId } = await ctx.params;
  const q = parseQuery(request, query);
  if (!q.ok) return q.response;
  const parsed = await parseBody(request, body);
  if (!parsed.ok) return parsed.response;
  const posted = shareWork(routeActor(), sourceId, { source: q.data.source, visibility: parsed.data.visibility });
  return posted ? json(posted) : error('Work event not found', 404);
});
