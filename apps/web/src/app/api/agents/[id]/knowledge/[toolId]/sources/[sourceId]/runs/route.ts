/**
 * C22: GET `?limit=&cursor=`: the sync runs of a source, newest first, paged by an opaque cursor (`limit` at most 50): `{ runs, next? }`.
 * Each run: id, trigger, start, end, status (running, ok, partial, failed), counts (seen, added, changed, removed, failed, chunks
 * embedded and reused), up to 50 errors with reasons. The last 100 runs are kept. For anyone who may read the agent.
 */
import { agentStore } from '@/lib/server/agents/store';
import { error, handler, json, parseQuery } from '@/lib/server/http';
import { runsOf, sourceOfBase } from '@/lib/server/knowledge-sources';
import { limitParam, pageSchema } from '@/lib/server/pagination';
import { canResource } from '@/lib/server/projects/access';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; toolId: string; sourceId: string }> };

const Query = pageSchema.extend({ limit: limitParam(50, 20) });

export const GET = handler(async (request: Request, { params }: Ctx) => {
  const { id, toolId, sourceId } = await params;
  if (!agentStore.get(id) || !canResource(routeActor(), 'agent', id, 'read') || !sourceOfBase(id, toolId, sourceId)) return error('Source not found', 404);
  const query = parseQuery(request, Query);
  if (!query.ok) return query.response;
  return json(runsOf(sourceId, query.data.cursor, query.data.limit));
});
