/**
 * POST /api/entities/:type/:id/facts { kind, statement, confidence? } — a statement about an entity that the brain keeps
 * and searches (docs/second-brain.md#entities). `kind` is one of the fact kinds (purpose, health, cost, failure…).
 * Editors of the entity's project.
 */
import { z } from 'zod';
import { FACT_KINDS } from '@/lib/shared/brain';
import { addEntityFact, canEntity, EntityError, getEntity } from '@/lib/server/brain/entities';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

const Body = z.object({ kind: z.enum(FACT_KINDS), statement: z.string().trim().min(1).max(1_000), confidence: z.number().min(0).max(1).optional() });

export const POST = handler(async (request: Request, ctx: { params: Promise<{ type: string; id: string }> }) => {
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  const { type, id } = await ctx.params;
  const actor = routeActor();
  const entity = getEntity(type, id);
  if (!entity || !canEntity(actor, entity, 'read')) return error('Entity not found', 404);
  if (!canEntity(actor, entity, 'update')) return error('You can’t change this entity', 403);
  try {
    return json({ fact: addEntityFact(entity, parsed.data) }, 201);
  } catch (caught) {
    if (caught instanceof EntityError) return error(caught.message, caught.status);
    throw caught;
  }
});
