/** What the router and the response cache did for an agent in its newest sessions (docs/agents.md "Layers"). GET only. */
import { layerStats } from '@/lib/server/agents/layer-stats';
import { agentStore } from '@/lib/server/agents/store';
import { error, handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  return agentStore.get(id) ? json({ stats: layerStats(id) }) : error('Agent not found', 404);
});
