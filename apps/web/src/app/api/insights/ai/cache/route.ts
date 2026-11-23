/**
 * The AI page's cache card (docs/llm-gateway.md, "The AI page"): the period's cache hit rate and savings over the calls
 * the caller can see, and the agents that miss most.
 *
 * GET ?period=24h|7d|30d|90d|custom&from=&to=&projectId=&agentId=&workflowId=&userId=&credentialId=&model=&purpose=&source=&surface=
 * (the page's filters narrow the card by the report's own rules; an unreadable id is 404)
 */
import { aiCacheReport } from '@/lib/server/ai-usage/cache-report';
import { handler, json, parseQuery } from '@/lib/server/http';
import { aiConsoleQuerySchema, spendQueryOf } from '@/lib/server/llm-gateway/console-schema';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => {
  const query = parseQuery(request, aiConsoleQuerySchema);
  if (!query.ok) return query.response;
  const { period, from, to, filters } = spendQueryOf(query.data);
  return json(aiCacheReport(routeActor(), period, Date.now(), { from, to }, filters));
});
