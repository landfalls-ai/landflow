/**
 * GET /api/runs/needs-you → `{ items }`: what waits for a person across the runs the caller can read (lib/server/journal/
 * needs-you.ts): waiting runs that ask for an approval, a form or an answer, and failed checks of the last 7 days nobody
 * settled. Each item: executionId, workflowId, workflowName, kind (`approval`, `form`, `question`, `check`), title, detail?,
 * actor?, spanId?, since.
 */
import { handler, json } from '@/lib/server/http';
import { needsYou } from '@/lib/server/journal/needs-you';
import { visibleIds } from '@/lib/server/projects';
import { routeActor } from '@/lib/server/projects/http';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  // Members see the runs of the workflows they see (owners and admins: all).
  const visible = visibleIds(routeActor(), 'workflow', store.listWorkflows().map((w) => w.id));
  return json({ items: needsYou(visible) });
});
