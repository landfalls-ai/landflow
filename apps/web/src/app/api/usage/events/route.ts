/** GET /api/usage/events — the ledger's events, newest first, with the same filters as /api/usage and `limit` (max 5,000). */
import { scopeForActor } from '@/lib/server/brain/scope';
import { z } from 'zod';
import { handler, json, parseQuery } from '@/lib/server/http';
import { limitParam } from '@/lib/server/pagination';
import { routeActor } from '@/lib/server/projects/http';
import { listUsageEvents, usageFilter } from '@/lib/server/usage/query';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => {
  const url = new URL(request.url);
  const query = parseQuery(request, z.object({ limit: limitParam(5000, 100) }));
  if (!query.ok) return query.response;
  const { limit } = query.data;
  return json({ events: listUsageEvents(usageFilter(url), { limit, scope: scopeForActor(routeActor()) }) });
});
