/**
 * PATCH /api/brain/work/:sourceId { visibility: private|team|org }?source=<tool> — change who reads one of the caller's own
 * work events: 200 with the item, or 404 when they have none by that id (someone else's is never found). `team` is the
 * people who share a project with the caller, `org` everyone. Needs the `brain:write` scope (or a session).
 *
 * DELETE /api/brain/work/:sourceId?source=<tool> — delete one of the caller's own work events: 204, or 404 when they have
 * none by that source and id (someone else's is never found). Needs the `brain:write` scope (or a session).
 */
import { z } from 'zod';
import { deleteWork, setWorkVisibility } from '@/lib/server/brain/work';
import { error, handler, json, parseBody, parseQuery } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ sourceId: string }> };

const query = z.object({ source: z.string().min(1).max(40) });
const patchQuery = z.object({ source: z.string().min(1).max(40).optional() });
const patchBody = z.object({ visibility: z.enum(['private', 'team', 'org']) });

export const PATCH = handler(async (request: Request, ctx: Ctx) => {
  const { sourceId } = await ctx.params;
  const q = parseQuery(request, patchQuery);
  if (!q.ok) return q.response;
  const body = await parseBody(request, patchBody);
  if (!body.ok) return body.response;
  const item = setWorkVisibility(routeActor(), sourceId, body.data.visibility, q.data.source);
  return item ? json(item) : error('Work event not found', 404);
});

export const DELETE = handler(async (request: Request, ctx: Ctx) => {
  const { sourceId } = await ctx.params;
  const parsed = parseQuery(request, query);
  if (!parsed.ok) return parsed.response;
  if (!deleteWork(routeActor(), parsed.data.source, sourceId)) return error('Work event not found', 404);
  return new Response(null, { status: 204 });
});
