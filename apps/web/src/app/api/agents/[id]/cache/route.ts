/** The response cache of an agent (docs/agents.md "Response cache"). GET — answers kept and times they were served again. DELETE — forget them all. */
import { responseCache } from '@/lib/server/agents/response-cache';
import { agentStore } from '@/lib/server/agents/store';
import { error, handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  return agentStore.get(id) ? json({ stats: responseCache.stats(id) }) : error('Agent not found', 404);
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  return agentStore.get(id) ? json({ cleared: responseCache.clear(id) }) : error('Agent not found', 404);
});
