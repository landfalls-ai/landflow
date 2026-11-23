/**
 * GET /api/brain/wiki/:type/:id — one page of the Brain page: the entity with its facts and open suggestions, the work
 * that names it (90 days), the people and teams on it, the pages it shares work with, the pages that name it, and the
 * summary the model wrote (with `stale` when its facts or work changed since). `canEdit` when the caller can change it.
 */
import { canEntity, getEntity } from '@/lib/server/brain/entities';
import { scopeForActor } from '@/lib/server/brain/scope';
import { wikiPage } from '@/lib/server/brain/wiki';
import { error, handler, json } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ type: string; id: string }> };

export const GET = handler(async (_request: Request, ctx: Ctx) => {
  const { type, id } = await ctx.params;
  const actor = routeActor();
  const entity = getEntity(type, id);
  if (!entity || !canEntity(actor, entity, 'read')) return error('Page not found', 404);
  return json(wikiPage(entity, scopeForActor(actor), actor, canEntity(actor, entity, 'update')));
});
