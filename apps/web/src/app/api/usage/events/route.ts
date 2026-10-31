/** GET /api/usage/events — the ledger's events, newest first, with the same filters as /api/usage and `limit` (max 5,000). */
import { scopeForActor } from '@/lib/server/brain/scope';
import { handler, json } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';
import { listUsageEvents, usageFilter } from '@/lib/server/usage/query';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get('limit') ?? 100) || 100;
  return json({ events: listUsageEvents(usageFilter(url), { limit, scope: scopeForActor(routeActor()) }) });
});
