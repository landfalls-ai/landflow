/**
 * AI usage and estimated cost (lib/server/ai-usage): what model calls used, per model and per day, for one
 * execution, workflow or agent, or for everything (grouped per workflow for Insights, or per agent).
 *
 * GET ?executionId=&workflowId=&agentId=&days=30&from=YYYY-MM-DD&to=YYYY-MM-DD&group=workflow|agent
 */
import { aiUsageMeter } from '@/lib/server/ai-usage';
import { error, handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const GET = handler(async (request: Request) => {
  const url = new URL(request.url);
  const param = (name: string) => url.searchParams.get(name)?.trim() || undefined;
  const meter = aiUsageMeter();
  const executionId = param('executionId');
  // An execution's usage is all-time; the rest defaults to the last 30 days (`days=0`: everything).
  const days = Math.min(3660, Math.max(0, Number(param('days') ?? (executionId ? 0 : 30)) || 0));
  const from = param('from') ?? (days ? meter.today(Date.now() - (days - 1) * 86_400_000) : undefined);
  const to = param('to');
  if ((from && !DAY.test(from)) || (to && !DAY.test(to))) return error('from and to are days: YYYY-MM-DD');
  const group = param('group');
  return json(
    meter.report({
      executionId,
      workflowId: param('workflowId'),
      agentId: param('agentId'),
      from,
      to,
      ...((group === 'workflow' || group === 'agent') && { group }),
    }),
  );
});
