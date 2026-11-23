/**
 * The runs behind one row of the AI page's report (docs/llm-gateway.md "The AI page"): the report's period and filters plus
 * `group` and `key` (the row), `order` (`cost` or `recent`), `cursor` and `format=json|csv`. Lists only what the caller may open
 * (rule 3); the rest is counted in `hidden`. A filter or key naming something the caller can't read answers 404.
 *
 * GET ?group=agent&key=<id>&period=7d|24h|30d|90d|custom&from=&to=&projectId=&agentId=&workflowId=&userId=&credentialId=&model=&purpose=&source=&surface=
 */
import { handler, json, parseQuery } from '@/lib/server/http';
import { aiSpendListQuerySchema, spendRuns, spendRunsCsv } from '@/lib/server/ai-usage/spend-lists';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => {
  const query = parseQuery(request, aiSpendListQuerySchema);
  if (!query.ok) return query.response;
  const actor = routeActor();
  if (query.data.format === 'csv') {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return new Response(spendRunsCsv(actor, query.data), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="landflow-ai-runs-${stamp}.csv"`,
        'cache-control': 'no-store',
      },
    });
  }
  return json(spendRuns(actor, query.data));
});
