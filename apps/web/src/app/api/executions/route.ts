import { handler, json } from '@/lib/server/http';
import { visibleIds } from '@/lib/server/projects';
import { routeActor } from '@/lib/server/projects/http';
import { liveExecutions } from '@/lib/server/runner';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => {
  const url = new URL(request.url);
  const workflowId = url.searchParams.get('workflowId') ?? undefined;
  const limit = Number(url.searchParams.get('limit') ?? 100);
  const running = liveExecutions(workflowId);
  // A resumed execution is live and still saved as waiting: list it once.
  const ids = new Set(running.map((e) => e.id));
  // Members see the executions of the workflows they see (owners and admins: all).
  const workflows = visibleIds(routeActor(), 'workflow', store.listWorkflows().map((w) => w.id));
  const all = [...running, ...store.listExecutions({ workflowId, limit: workflows ? Math.max(limit * 4, 500) : limit }).filter((e) => !ids.has(e.id))];
  return json({ executions: (workflows ? all.filter((e) => e.workflowId && workflows.has(e.workflowId)) : all).slice(0, limit) });
});
