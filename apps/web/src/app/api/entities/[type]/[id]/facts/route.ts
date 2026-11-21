/**
 * POST /api/entities/:type/:id/facts { kind, statement, confidence?, isStatic?, parentId?, relation?, forgetAfter? } — a
 * statement about an entity that the brain keeps and searches (docs/second-brain.md#entities). `kind` is one of the fact
 * kinds (purpose, health, cost, failure…). `isStatic` marks a fact that never changes (the study never stales or rewrites
 * it); `parentId` with `relation` (`extends` or `derives`) links it to a fact the caller can read, else 404;
 * `forgetAfter` is when it leaves recall. Editors of the entity's project.
 */
import { z } from 'zod';
import { FACT_KINDS } from '@/lib/shared/brain';
import { getFact } from '@/lib/server/brain/facts';
import { canFact } from '@/lib/server/brain/scope';
import { addEntityFact, canEntity, getEntity } from '@/lib/server/brain/entities';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

const Body = z
  .object({
    kind: z.enum(FACT_KINDS),
    statement: z.string().trim().min(1).max(1_000),
    confidence: z.number().min(0).max(1).optional(),
    isStatic: z.boolean().optional(),
    parentId: z.string().min(1).max(300).optional(),
    relation: z.enum(['extends', 'derives']).optional(),
    forgetAfter: z.string().datetime({ offset: true }).optional(),
  })
  .refine((b) => !b.parentId === !b.relation, 'parentId and relation go together');

export const POST = handler(async (request: Request, ctx: { params: Promise<{ type: string; id: string }> }) => {
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  const { type, id } = await ctx.params;
  const actor = routeActor();
  const entity = getEntity(type, id);
  if (!entity || !canEntity(actor, entity, 'read')) return error('Entity not found', 404);
  if (!canEntity(actor, entity, 'update')) return error('You can’t change this entity', 403);
  if (parsed.data.parentId) {
    const parent = getFact(parsed.data.parentId);
    if (!parent || parent.latest === false || !canFact(actor, parent, 'read')) return error('Linked fact not found', 404);
  }
  return json({ fact: addEntityFact(entity, parsed.data) }, 201);
});
