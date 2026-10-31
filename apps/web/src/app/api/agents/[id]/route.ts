import { agentConfigSchema, asConfig } from '@/lib/server/agents/http';
import { agentStore } from '@/lib/server/agents/store';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { removeFromKagent } from '@/lib/server/kagent/deploy';
import { logger } from '@/lib/server/telemetry';
import { ownershipOf } from '@/lib/server/projects';
import { forgetDeleted, routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const agent = agentStore.get((await params).id);
  return agent ? json({ agent, ownership: ownershipOf(routeActor(), 'agent', agent.id) }) : error('Agent not found', 404);
});

/** Autosave of the builder: replaces the draft; published versions stay as they are. */
export const PUT = handler(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, agentConfigSchema);
  if (!body.ok) return body.response;
  const agent = agentStore.saveDraft((await params).id, asConfig(body.data));
  return agent ? json({ agent }) : error('Agent not found', 404);
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  // An agent deployed to kagent leaves it too (if kagent can't be reached, its resources stay and say which agent they were).
  if (agentStore.get(id)?.kagent) await removeFromKagent(id).catch((cause) => logger.warn('kagent: a deleted agent’s resources could not be removed', { agentId: id, error: (cause as Error).message }));
  if (!agentStore.delete(id)) return error('Agent not found', 404);
  forgetDeleted('agent', id);
  return json({ ok: true });
});
