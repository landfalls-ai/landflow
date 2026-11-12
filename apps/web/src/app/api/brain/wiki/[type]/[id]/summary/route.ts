/**
 * POST /api/brain/wiki/:type/:id/summary — have the brain's model write (or rewrite) the page's summary from what the
 * caller can see of it, and keep it. 409 when the brain has no model; 502 when the model fails.
 */
import { canEntity, getEntity } from '@/lib/server/brain/entities';
import { scopeForActor } from '@/lib/server/brain/scope';
import { WikiError, writeSummary } from '@/lib/server/brain/wiki';
import { error, handler, json } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ type: string; id: string }> };

export const POST = handler(async (request: Request, ctx: Ctx) => {
  const { type, id } = await ctx.params;
  const actor = routeActor();
  const entity = getEntity(type, id);
  if (!entity || !canEntity(actor, entity, 'read')) return error('Page not found', 404);
  try {
    return json({ summary: await writeSummary(entity, scopeForActor(actor), actor, { signal: request.signal }) });
  } catch (caught) {
    if (caught instanceof WikiError) return error(caught.message, caught.status);
    throw caught;
  }
});
