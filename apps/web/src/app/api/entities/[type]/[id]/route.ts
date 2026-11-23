/**
 * One entity (docs/second-brain.md#entities).
 * GET    /api/entities/:type/:id — the entity, its profile, the facts about it and its open suggestions.
 * PATCH  { name?, description?, owner?, projectId?, attrs? } — change it (an empty string clears the description or owner;
 *        a null attribute removes it). Editors of its project.
 * DELETE — remove it with its facts and profile; its open suggestions expire. Editors of its project.
 */
import { z } from 'zod';
import { canEntity, deleteEntity, entityKnowledge, getEntity, upsertEntity } from '@/lib/server/brain/entities';
import { listProposals } from '@/lib/server/brain/proposals';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { creationProject } from '@/lib/server/projects/access';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ type: string; id: string }> };

async function find(ctx: Ctx, action: 'read' | 'update') {
  const { type, id } = await ctx.params;
  const actor = routeActor();
  const entity = getEntity(type, id);
  if (!entity || !canEntity(actor, entity, 'read')) return { response: error('Entity not found', 404) };
  if (action === 'update' && !canEntity(actor, entity, 'update')) return { response: error('You can’t change this entity', 403) };
  return { entity, actor };
}

export const GET = handler(async (_request: Request, ctx: Ctx) => {
  const found = await find(ctx, 'read');
  if (!found.entity) return found.response;
  return json(entityKnowledge(found.entity, (ref) => listProposals({ status: 'open', limit: 50 }).filter((p) => p.target.type === 'entity' && p.target.id === ref)));
});

const Body = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(1_000).optional(),
  owner: z.string().max(120).optional(),
  projectId: z.string().max(200).optional(),
  attrs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});

export const PATCH = handler(async (request: Request, ctx: Ctx) => {
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  const found = await find(ctx, 'update');
  if (!found.entity) return found.response;
  const { projectId, ...patch } = parsed.data;
  const moved = projectId ? creationProject(found.actor, projectId) : undefined;
  return json({ entity: upsertEntity({ ...patch, type: found.entity.type, id: found.entity.id, ...(moved && { projectId: moved }) }).entity });
});

export const DELETE = handler(async (_request: Request, ctx: Ctx) => {
  const found = await find(ctx, 'update');
  if (!found.entity) return found.response;
  return json({ ok: deleteEntity(found.entity.type, found.entity.id) });
});
