/**
 * The You card on the AI page (docs/llm-gateway.md, "The AI page"): the caller's own AI spend (today, this month, the
 * period's series, by model, purpose and surface) and their own user caps. Only their own rows and caps, whoever asks.
 *
 * GET ?period=24h|7d|30d|90d (default 7d)
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
