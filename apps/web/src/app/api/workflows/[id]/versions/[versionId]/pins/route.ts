/** GET /api/workflows/:id/versions/:versionId/pins — `{ pins: AgentPin[] }`: the agent versions a workflow version runs (AG21; empty for a version never published). */
import { pinsFor } from '@/lib/server/agents/versions';
import { error, handler, json } from '@/lib/server/http';
import { canResource } from '@/lib/server/projects/access';
import { routeActor } from '@/lib/server/projects/http';
import { store } from '@/lib/server/store';
import { getVersion } from '@/lib/server/versions';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; versionId: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id, versionId } = await params;
  if (!store.getWorkflow(id) || !canResource(routeActor(), 'workflow', id, 'read')) return error('Workflow not found', 404);
  const version = getVersion(id, versionId);
  if (!version) return error('Version not found', 404);
  const nodes = new Map(version.workflow.nodes.map((n) => [n.id, n.name]));
  return json({ pins: pinsFor(versionId).map((p) => ({ ...p, ...(nodes.get(p.nodeId) && { nodeName: nodes.get(p.nodeId) }) })) });
});
