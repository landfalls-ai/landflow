/**
 * POST /api/proposals/:id/applied — the editor applied a suggestion's changes itself (the canvas card, where the person
 * sees the diff and saves): record it as applied, with the baseline its effect is measured against.
 */
import { finishApplied, getProposal } from '@/lib/server/brain/proposals';
import { canProposal } from '@/lib/server/brain/scope';
import { database } from '@/lib/server/db';
import { error, handler, json } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export const POST = handler(async (_request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const actor = routeActor();
  const proposal = getProposal(id);
  if (!proposal || !canProposal(actor, proposal, 'read')) return error('Suggestion not found', 404);
  if (!canProposal(actor, proposal, 'update')) return error('You can’t change what this suggestion is about', 403);
  const { proposal: applied, started } = finishApplied(proposal, { actorId: actor.id }, database());
  return json({ proposal: applied, ...(started.length && { started }) });
});
