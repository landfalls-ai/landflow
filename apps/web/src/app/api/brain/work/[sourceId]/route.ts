/**
 * DELETE /api/brain/work/:sourceId?source=<tool> — delete one of the caller's own work events: 204, or 404 when they have
 * none by that source and id (someone else's is never found). Needs the `brain:write` scope (or a session).
 */
import { z } from 'zod';
import { deleteWork } from '@/lib/server/brain/work';
import { error, handler, parseQuery } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ sourceId: string }> };

const query = z.object({ source: z.string().min(1).max(40) });

export const DELETE = handler(async (request: Request, ctx: Ctx) => {
  const { sourceId } = await ctx.params;
  const parsed = parseQuery(request, query);
  if (!parsed.ok) return parsed.response;
  if (!deleteWork(routeActor(), parsed.data.source, sourceId)) return error('Work event not found', 404);
  return new Response(null, { status: 204 });
});
