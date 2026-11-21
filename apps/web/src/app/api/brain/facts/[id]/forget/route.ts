/**
 * POST /api/brain/facts/:id/forget { reason, forgetAfter? } — forget a fact softly (docs/second-brain.md#forgetting-a-fact):
 * it leaves every list, search, prompt and MCP tool, the row stays with the reason and who, and a restore brings it back.
 * With `forgetAfter` (an ISO time, a minute to five years ahead) it goes at that time instead. Editors of the fact's
 * subject (a workflow, an agent, an entity's project; owners and admins for the rest); 404 for a caller who may not see it.
 */
import { z } from 'zod';
import { factFor, forgetFact } from '@/lib/server/brain/fact-lifecycle';
import { handler, json, parseBody } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

const Body = z.object({ reason: z.string().trim().min(1).max(500), forgetAfter: z.string().datetime({ offset: true }).optional() });

export const POST = handler(async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  const actor = routeActor();
  const id = decodeURIComponent((await ctx.params).id);
  factFor(actor, id, 'update');
  return json({ fact: await forgetFact(id, parsed.data, { userId: actor.id, name: actor.name }) });
});
