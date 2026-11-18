/**
 * AG17: GET /api/agents/:id/moves → { moves }: what moved into this agent from workflows' wired sub-nodes and from which flows
 * (only flows the caller can read), newest first (docs/agents.md#from-workflows). Read access is the agent's.
 */
import { movesOf } from '@/lib/server/agents/flow-moves';
import { agentStore } from '@/lib/server/agents/store';
import { error, handler, json } from '@/lib/server/http';
import { canResource } from '@/lib/server/projects/access';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  const actor = routeActor();
  if (!agentStore.get(id) || !canResource(actor, 'agent', id, 'read')) return error('Agent not found', 404);
  return json({ moves: movesOf({ agentId: id }, actor) });
});
