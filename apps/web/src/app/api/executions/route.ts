import { listExecutionsPage } from '@/lib/server/executions-query';
import { handler, json, parseQuery } from '@/lib/server/http';
import { pageSchema } from '@/lib/server/pagination';
import { visibleIds } from '@/lib/server/projects';
import { routeActor } from '@/lib/server/projects/http';
import { liveExecutions } from '@/lib/server/runner';
import { store } from '@/lib/server/store';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const querySchema = pageSchema.extend({ workflowId: z.string().min(1).max(200).optional() });

/** GET /api/executions?workflowId=&limit=&cursor= — newest first, `{ executions, nextCursor? }`; running ones are listed on the first page only. */
export const GET = handler(async (request: Request) => {
  const query = parseQuery(request, querySchema);
  if (!query.ok) return query.response;
  const { workflowId, limit, cursor } = query.data;
  // Members see the executions of the workflows they see (owners and admins: all).
  const workflows = visibleIds(routeActor(), 'workflow', store.listWorkflows().map((w) => w.id));
  const page = listExecutionsPage({ workflowId, limit, cursor, visibleWorkflowIds: workflows ? [...workflows] : null });
  if (cursor) return json(page);
  // A resumed execution is live and still saved as waiting: list it once.
  const running = liveExecutions(workflowId).filter((e) => !workflows || (e.workflowId && workflows.has(e.workflowId)));
  const ids = new Set(running.map((e) => e.id));
  return json({ ...page, executions: [...running, ...page.executions.filter((e) => !ids.has(e.id))] });
});
