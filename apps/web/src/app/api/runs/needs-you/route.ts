/**
 * GET /api/runs/needs-you → `{ items }`: what waits for a person across the runs the caller can read (lib/server/journal/
 * needs-you.ts): waiting runs that ask for an approval, a form or an answer, and failed checks of the last 7 days nobody
 * settled. Each item: executionId, workflowId, workflowName, kind (`approval`, `form`, `question`, `check`), title, detail?,
 * actor?, spanId?, since. A `budget` item (a project's AI budget warning or stop, for its admins and the budget's owner) has
 * projectId, incidentId, incidentKind, href, canRaise and canResume too (docs/projects-and-goals.md#ai-budget). A `task` item (a
 * project task's run that waits for an Approve, or for a tool approval in the agent's session, for the project's editors and
 * admins) has projectId, taskId, taskRunId, taskRunStatus, href and canDecide (docs/projects-and-goals.md#tasks). An `approval` item of a run nobody watches that waits in the approval inbox (docs/approval-inbox.md) has requestId, inboxStatus, tool, agentName, agentVersion, workflowVersion, destination, expiresAt and canDecide (one item per waiting request). A `spend` item (a
 * forecast over a cap, or unusual AI spend of a day; for the people the spend is theirs to hear, docs/llm-gateway.md#forecasts-and-unusual-spend)
 * has flagId, flagKind (`anomaly` or `forecast`), href (the AI page at the day) and canAcknowledge.
 */
import { aiUsageMeter } from '@/lib/server/ai-usage';
import { spendItems } from '@/lib/server/ai-usage/spend-flags'; // SP23:
import { budgetItems } from '@/lib/server/budgets/enforce';
import { handler, json } from '@/lib/server/http';
import { taskItems } from '@/lib/server/tasks/needs-you';
import { needsYou } from '@/lib/server/journal/needs-you';
import { visibleIds } from '@/lib/server/projects';
import { routeActor } from '@/lib/server/projects/http';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  // Members see the runs of the workflows they see (owners and admins: all).
  const visible = visibleIds(routeActor(), 'workflow', store.listWorkflows().map((w) => w.id));
  const actor = routeActor();
  // PC14: a project's AI budget incidents join the run items, newest first.
  // Budget items are added after needsYou() cut to its MAX_ITEMS, so the answer can pass it.
  const items = [...(await needsYou(visible, Date.now(), actor)), ...budgetItems(actor, aiUsageMeter()), ...taskItems(actor), ...spendItems(actor, aiUsageMeter().today())].sort((a, b) => b.since.localeCompare(a.since));
  return json({ items });
});
