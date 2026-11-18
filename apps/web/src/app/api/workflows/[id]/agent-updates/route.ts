/**
 * GET /api/workflows/:id/agent-updates — `{ updates: AgentUpdate[], offer? }` (`offer`: the update card's data, when there are updates): the agents whose published version is newer than the one
 * production runs (AG21: "Alert triager v3 is available"). Read access is the workflow's.
 */
import { updateOffer } from '@/lib/server/assistant/publish-tools';
import { agentUpdates } from '@/lib/server/agents/versions';
import { error, handler, json } from '@/lib/server/http';
import { canResource } from '@/lib/server/projects/access';
import { routeActor } from '@/lib/server/projects/http';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!store.getWorkflow(id) || !canResource(routeActor(), 'workflow', id, 'read')) return error('Workflow not found', 404);
  const updates = agentUpdates({ workflowId: id });
  // `offer`: the card that tests and publishes them all (the editor's Test and update), when there are any.
  const offer = updates.length ? updateOffer(id, [...new Set(updates.map((u) => u.agentId))]) : undefined;
  return json({ updates, ...(offer && typeof offer !== 'string' && { offer }) });
});
