/**
 * C22: one source of a knowledge base. PATCH `{ name?, schedule?, paused?, settings? }` changes it (the schedule, Pause and Resume,
 * a new place); DELETE removes it, with `?deleteChunks=1` also deleting every chunk it wrote (answers `{ removedChunks }`; 409 while
 * a sync of it runs). Needs update rights on the agent, else 404; a source of another base is 404 too.
 */
import { z } from 'zod';
import { agentStore } from '@/lib/server/agents/store';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { removeSource, sourceOfBase, updateSource } from '@/lib/server/knowledge-sources';
import { canResource } from '@/lib/server/projects/access';
import { routeActor } from '@/lib/server/projects/http';
import { SOURCE_SCHEDULES } from '@/lib/shared/knowledge-sources';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; toolId: string; sourceId: string }> };

const Body = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  schedule: z.enum(SOURCE_SCHEDULES as [string, ...string[]]).optional(),
  paused: z.boolean().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

async function owned({ params }: Ctx) {
  const { id, toolId, sourceId } = await params;
  const allowed = agentStore.get(id) && canResource(routeActor(), 'agent', id, 'update');
  return allowed && sourceOfBase(id, toolId, sourceId) ? sourceId : undefined;
}

export const PATCH = handler(async (request: Request, ctx: Ctx) => {
  const sourceId = await owned(ctx);
  if (!sourceId) return error('Source not found', 404);
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  return json(await updateSource(sourceId, parsed.data as Parameters<typeof updateSource>[1]));
});

export const DELETE = handler(async (request: Request, ctx: Ctx) => {
  const sourceId = await owned(ctx);
  if (!sourceId) return error('Source not found', 404);
  const deleteChunks = ['1', 'true'].includes(new URL(request.url).searchParams.get('deleteChunks') ?? '');
  return json(await removeSource(sourceId, { deleteChunks }));
});
