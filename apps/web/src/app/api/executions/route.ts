import { handler, json } from '@/lib/server/http';
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
  return json({ executions: [...running, ...store.listExecutions({ workflowId, limit }).filter((e) => !ids.has(e.id))].slice(0, limit) });
});
