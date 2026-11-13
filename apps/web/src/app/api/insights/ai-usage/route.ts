/**
 * AI usage and estimated cost (lib/server/ai-usage): what model calls used, per model and per day, for one
 * execution, workflow or agent, or for everything (grouped per workflow for Insights, or per agent).
 *
 * Owners and admins see everything; a member sees the workflows and agents they can open (one they can't answers 404,
 * so ids aren't confirmed) and, with no filter, the report is limited to those.
 *
 * GET ?executionId=&workflowId=&agentId=&days=30&from=YYYY-MM-DD&to=YYYY-MM-DD&group=workflow|agent
 */
import { aiUsageMeter } from '@/lib/server/ai-usage';
import { scopeForActor } from '@/lib/server/brain/scope';
import { error, handler, json } from '@/lib/server/http';
import { canResource, executionWorkflowId } from '@/lib/server/projects';
import { routeActor } from '@/lib/server/projects/http';
import { liveExecution } from '@/lib/server/runner';

export const dynamic = 'force-dynamic';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const GET = handler(async (request: Request) => {
  const url = new URL(request.url);
  const param = (name: string) => url.searchParams.get(name)?.trim() || undefined;
  const meter = aiUsageMeter();
  const executionId = param('executionId');
  const workflowId = param('workflowId');
  const agentId = param('agentId');
  const actor = routeActor();
  const scope = scopeForActor(actor);
  if (scope) {
    // A run that is still going has no saved row yet: its workflow comes from the runner, as the file route does.
    const execution = executionId && (executionWorkflowId(executionId) ?? liveExecution(executionId)?.workflowId);
    if (
      (executionId && (!execution || !canResource(actor, 'workflow', execution, 'read'))) ||
      (workflowId && !canResource(actor, 'workflow', workflowId, 'read')) ||
      (agentId && !canResource(actor, 'agent', agentId, 'read'))
    ) {
      return error('Not found', 404);
    }
  }
  // An execution's usage is all-time; the rest defaults to the last 30 days (`days=0`: everything).
  const days = Math.min(3660, Math.max(0, Number(param('days') ?? (executionId ? 0 : 30)) || 0));
  const from = param('from') ?? (days ? meter.today(Date.now() - (days - 1) * 86_400_000) : undefined);
  const to = param('to');
  if ((from && !DAY.test(from)) || (to && !DAY.test(to))) return error('from and to are days: YYYY-MM-DD');
  const group = param('group');
  return json(
    meter.report({
      executionId,
      workflowId,
      agentId,
      from,
      to,
      ...(scope && !executionId && { within: { workflows: scope.workflows ?? new Set<string>(), agents: scope.agents ?? new Set<string>() } }),
      ...((group === 'workflow' || group === 'agent') && { group }),
    }),
  );
});
