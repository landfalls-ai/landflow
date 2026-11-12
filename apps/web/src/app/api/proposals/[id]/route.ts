/**
 * GET   /api/proposals/:id — one suggestion.
 * PATCH /api/proposals/:id { action: 'dismiss', reason: intended|not-relevant|wrong|done, note? } | { action: 'snooze', days }
 *       — decide it (edit access to its workflow or agent; owners and admins for the instance's; or being in its audience).
 */
import { z } from 'zod';
import { DISMISS_REASONS } from '@/lib/shared/brain';
import { canDecide, canSee } from '@/lib/server/brain/audience';
import { dismissProposal, getProposal, ProposalError, snoozeProposal } from '@/lib/server/brain/proposals';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const proposal = getProposal(id);
  if (!proposal || !canSee(routeActor(), proposal)) return error('Suggestion not found', 404);
  return json({ proposal });
});

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('dismiss'), reason: z.enum(DISMISS_REASONS), note: z.string().max(500).optional() }),
  z.object({ action: z.literal('snooze'), days: z.number().int().min(1).max(90) }),
]);

export const PATCH = handler(async (request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  const actor = routeActor();
  const proposal = getProposal(id);
  if (!proposal || !canSee(actor, proposal)) return error('Suggestion not found', 404);
  if (!canDecide(actor, proposal, 'other')) return error('You can’t decide this suggestion', 403);
  try {
    const body = parsed.data;
    const next = body.action === 'dismiss' ? dismissProposal(id, body.reason, { note: body.note, actorId: actor.id }) : snoozeProposal(id, body.days, undefined, { actorId: actor.id });
    return json({ proposal: next });
  } catch (caught) {
    if (caught instanceof ProposalError) return error(caught.message, caught.status);
    throw caught;
  }
});
