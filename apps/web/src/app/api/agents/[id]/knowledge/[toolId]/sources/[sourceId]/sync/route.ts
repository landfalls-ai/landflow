/**
 * C22: POST: Sync now. Starts a sync of the source in the background on this process and answers 202 `{ runId }`; 409
 * `{ error, runId }` when a sync of it is already running (only one runs at a time, across processes). Needs update rights on the agent.
 */
import { agentStore } from '@/lib/server/agents/store';
import { error, handler, json } from '@/lib/server/http';
import { sourceOfBase, syncNow } from '@/lib/server/knowledge-sources';
import { canResource } from '@/lib/server/projects/access';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; toolId: string; sourceId: string }> };

export const POST = handler(async (_request: Request, { params }: Ctx) => {
  const { id, toolId, sourceId } = await params;
  if (!agentStore.get(id) || !canResource(routeActor(), 'agent', id, 'update') || !sourceOfBase(id, toolId, sourceId)) return error('Source not found', 404);
  const started = await syncNow(sourceId);
  if ('running' in started) return json({ error: 'A sync of this source is running', ...(started.runId && { runId: started.runId }) }, { status: 409 });
  return json(started, { status: 202 });
});
