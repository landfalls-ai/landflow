import { z } from 'zod';
import { agentStore } from '@/lib/server/agents/store';
import { forgetAgentMemory, restoreAgentMemory, viewOf } from '@/lib/server/agents/memory';
import { MemoryNotFoundError } from '@/lib/server/memory';
import { canResource, resourceAccess } from '@/lib/server/projects/access';
import { routeActor } from '@/lib/server/projects/http';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; memoryId: string }> };

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('forget'), reason: z.string().trim().min(1).max(500), user: z.string().trim().min(1).max(200).optional() }),
  z.object({ action: z.literal('restore'), user: z.string().trim().min(1).max(200).optional() }),
]);

/**
 * Forget (with a reason) or restore one memory an agent holds about a person. A person acts on their own memories; the agent's
 * editors name another person with `user`. Anyone else, and a memory that is not that person's, gets "not found".
 */
export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id, memoryId } = await params;
  const actor = routeActor();
  if (!agentStore.get(id) || !resourceAccess(actor, 'agent', id)) return error('Agent not found', 404);
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const userId = body.user ?? actor.id;
  if (userId !== actor.id && !canResource(actor, 'agent', id, 'update')) return error('Memory not found', 404);
  try {
    const fact = body.action === 'forget' ? await forgetAgentMemory(id, userId, memoryId, body.reason, actor.id) : restoreAgentMemory(id, userId, memoryId, actor.id);
    return json({ item: viewOf(fact) });
  } catch (caught) {
    if (caught instanceof MemoryNotFoundError) return error('Memory not found', 404);
    throw caught;
  }
});
