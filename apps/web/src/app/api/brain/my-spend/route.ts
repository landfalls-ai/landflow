/**
 * GET /api/brain/my-spend?period=24h|7d|30d|90d (default 7d) — the caller's own AI spend (docs/llm-gateway.md, "Who
 * sees what", rule 5): the same answer as GET /api/insights/ai/me, reached with `brain:read` (`brain:write` includes it)
 * so a brain key (the CLI, the landflow-brain mod's status line) can read it. Only the caller's own rows and caps.
 */
import { handler, json, parseQuery } from '@/lib/server/http';
import { mySpend } from '@/lib/server/ai-usage/my-spend';
import { myAiSpendQuerySchema } from '@/lib/server/ai-usage/my-spend-schema';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => {
  const query = parseQuery(request, myAiSpendQuerySchema);
  if (!query.ok) return query.response;
  return json(mySpend(routeActor().id, query.data.period));
});
