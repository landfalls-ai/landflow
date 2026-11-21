/**
 * POST /api/brain/facts/:id/restore — bring a forgotten fact back (docs/second-brain.md#forgetting-a-fact). Editors of the
 * fact's subject; 404 for a caller who may not see it.
 */
import { factFor, restoreFact } from '@/lib/server/brain/fact-lifecycle';
import { handler, json } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

export const POST = handler(async (_request: Request, ctx: { params: Promise<{ id: string }> }) => {
  const actor = routeActor();
  const id = decodeURIComponent((await ctx.params).id);
  factFor(actor, id, 'update');
  return json({ fact: restoreFact(id, { userId: actor.id, name: actor.name }) });
});
