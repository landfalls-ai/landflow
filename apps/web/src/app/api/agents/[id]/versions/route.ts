/** GET /api/agents/:id/versions — `{ versions: AgentVersionUse[] }`: each published version and the workflow versions that pin it, production marked (AG21). */
import { agentVersionUses } from '@/lib/server/agents/versions';
import { agentStore } from '@/lib/server/agents/store';
import { error, handler, json } from '@/lib/server/http';
import { canResource } from '@/lib/server/projects/access';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!agentStore.get(id) || !canResource(routeActor(), 'agent', id, 'read')) return error('Agent not found', 404);
  // Workflows the caller cannot open stay out of `usedBy` (an agent shared with all projects is readable by everyone).
  const actor = routeActor();
  const versions = agentVersionUses(id).map((v) => ({ ...v, usedBy: v.usedBy.filter((u) => canResource(actor, 'workflow', u.workflowId, 'read')) }));
  return json({ versions });
});
