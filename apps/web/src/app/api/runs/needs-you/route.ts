/**
 * GET /api/runs/needs-you → `{ items }`: what waits for a person across the runs the caller can read (lib/server/journal/
 * needs-you.ts): waiting runs that ask for an approval, a form or an answer, and failed checks of the last 7 days nobody
 * settled. Each item: executionId, workflowId, workflowName, kind (`approval`, `form`, `question`, `check`), title, detail?,
 * actor?, spanId?, since. A `budget` item (a project's AI budget warning or stop, for its admins and the budget's owner) has
 * projectId, incidentId, incidentKind, href, canRaise and canResume too (docs/projects-and-goals.md#ai-budget).
 */
import { aiUsageMeter } from '@/lib/server/ai-usage';
import { budgetItems } from '@/lib/server/budgets/enforce';
import { handler, json } from '@/lib/server/http';
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
  const items = [...(await needsYou(visible)), ...budgetItems(actor, aiUsageMeter())].sort((a, b) => b.since.localeCompare(a.since));
  return json({ items });
});
