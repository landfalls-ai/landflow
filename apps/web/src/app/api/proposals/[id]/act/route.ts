/**
 * POST /api/proposals/:id/act { action, note? } — take one of the buttons a flow put on a suggestion (its `actions`).
 * Records the decision (`decision.action` is the button's id), counts the suggestion as applied, and starts the
 * workflows on On Suggestion Decided. Same access as apply. Returns `{ proposal, warnings, started? }`; 400 when the
 * suggestion has no such action, 409 when it is already decided.
 */
import { z } from 'zod';
import { canDecide, canSee } from '@/lib/server/brain/audience';
import { actOnProposal, getProposal } from '@/lib/server/brain/proposals';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const Body = z.object({ action: z.string().trim().min(1).max(64), note: z.string().max(500).optional() });

export const POST = handler(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  const actor = routeActor();
  const proposal = getProposal(id);
  if (!proposal || !canSee(actor, proposal)) return error('Suggestion not found', 404);
  if (!canDecide(actor, proposal, 'other')) return error('You can’t decide this suggestion', 403);
  return json(actOnProposal(id, parsed.data.action, { note: parsed.data.note, actorId: actor.id }));
});
