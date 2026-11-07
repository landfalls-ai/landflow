/** The response cache of an agent (docs/agents.md "Response cache"). GET — answers kept and times they were served again. DELETE — forget them all. */
import { responseCache } from '@/lib/server/agents/response-cache';
import { semanticCache } from '@/lib/server/agents/semantic-cache';
import { agentStore } from '@/lib/server/agents/store';
import { error, handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!agentStore.get(id)) return error('Agent not found', 404);
  const exact = responseCache.stats(id);
  const similar = semanticCache.stats(id);
  return json({ stats: { entries: exact.entries, hits: exact.hits + similar.hits, similarEntries: similar.entries } });
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!agentStore.get(id)) return error('Agent not found', 404);
  const cleared = responseCache.clear(id);
  semanticCache.clear(id);
  return json({ cleared });
});
