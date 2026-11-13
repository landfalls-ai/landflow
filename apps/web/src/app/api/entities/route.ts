/**
 * The entity registry (docs/second-brain.md#entities): initiatives, people, customers and systems the brain reasons about.
 * GET  ?type=initiative|person|customer|system&owner=&q=&projectId=&limit= — the entities in the projects you can open
 *      (owners and admins: all), by name.
 * POST { type, name, id?, description?, owner?, projectId?, attrs? } — add an entity (201), or update the one with `id`
 *      (200; fields left out stay). Needs editor access to the project; new ones go to `projectId` or your personal project.
 */
import { z } from 'zod';
import { ENTITY_TYPES } from '@/lib/shared/brain';
import { canEntity, getEntity, listEntities, upsertEntity } from '@/lib/server/brain/entities';
import { scopeForActor } from '@/lib/server/brain/scope';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { creationProject } from '@/lib/server/projects/access';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => {
  const url = new URL(request.url);
  const param = (name: string) => url.searchParams.get(name)?.trim() || undefined;
  const type = param('type');
  if (type && !(ENTITY_TYPES as readonly string[]).includes(type)) return error(`Unknown type “${type}”: ${ENTITY_TYPES.join(', ')}`, 400);
  const entities = listEntities({ type, owner: param('owner'), text: param('q'), projectId: param('projectId'), scope: scopeForActor(routeActor()), limit: Math.min(Number(param('limit') ?? 500) || 500, 1_000) });
  return json({ entities });
});

const Body = z.object({
  type: z.enum(ENTITY_TYPES),
  id: z.string().trim().max(64).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(1_000).optional(),
  owner: z.string().max(120).optional(),
  projectId: z.string().max(200).optional(),
  attrs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});

export const POST = handler(async (request: Request) => {
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  const actor = routeActor();
  const { projectId, ...input } = parsed.data;
  const existing = input.id ? getEntity(input.type, input.id) : undefined;
  if (existing) {
    if (!canEntity(actor, existing, 'read')) return error('Entity not found', 404);
    if (!canEntity(actor, existing, 'update')) return error('You can’t change this entity', 403);
    return json({ entity: upsertEntity({ ...input, ...(projectId && { projectId: creationProject(actor, projectId) }), source: 'api' }).entity }, 200);
  }
  if (!input.name) return error('An entity needs a name', 400);
  const project = creationProject(actor, projectId);
  const { entity } = upsertEntity({ ...input, ...(project && { projectId: project }), source: 'api' });
  return json({ entity }, 201);
});
