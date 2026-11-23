/**
 * The AI page's report (docs/llm-gateway.md): spend and tokens by project, goal, agent, workflow, person, model, source,
 * credential, surface and purpose, a daily series, the previous period, the caps, the cap-raise requests. Everyone who
 * reads runs may call it; the report holds only what the caller may see (the person group, every person by name).
 *
 * GET ?period=24h|7d|30d|90d|custom&from=&to=&projectId=&agentId=&workflowId=&userId=&credentialId=&model=&purpose=&source=&surface=&compare=1&stack=<group>
 */
import { handler, json, parseQuery } from '@/lib/server/http';
import { aiConsoleReport } from '@/lib/server/llm-gateway/console';
import { aiConsoleQuerySchema, spendQueryOf } from '@/lib/server/llm-gateway/console-schema';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => {
  const query = parseQuery(request, aiConsoleQuerySchema);
  if (!query.ok) return query.response;
  return json(aiConsoleReport(routeActor(), spendQueryOf(query.data)));
});
