/**
 * GET /api/runs/measures?workflowId=<id>&limit=<n ≤ 100, default 30> → `{ workflowId, workflowName, runs }`: a workflow's
 * latest saved runs, oldest first, each as a point over time: executionId, startedAt, status, durationMs, tokensIn,
 * tokensOut, costUsd?, failedSteps, checksFailed (lib/shared/run-compare.ts). A run profile can't define measures of its
 * own yet, so these are the generic ones.
 */
import { error, handler, json } from '@/lib/server/http';
import { measuresOf } from '@/lib/server/journal/runs-query';
import { visibleIds } from '@/lib/server/projects';
import { routeActor } from '@/lib/server/projects/http';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => {
  const q = new URL(request.url).searchParams;
  const workflowId = q.get('workflowId')?.trim();
  if (!workflowId) return error('Give a workflow: ?workflowId=<id>', 400);
  const workflow = store.getWorkflow(workflowId);
  const visible = visibleIds(routeActor(), 'workflow', [workflowId]);
  if (!workflow || (visible && !visible.has(workflowId))) return error('Workflow not found', 404);
  return json({ workflowId, workflowName: workflow.name, runs: await measuresOf(workflowId, q.has('limit') ? Number(q.get('limit')) : 30) });
});
