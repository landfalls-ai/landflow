/**
 * GET /api/goals/:id/progress?window=7|30 — what moved the goal and its sub-goals in the window, counted only from what the
 * caller may see (404 `Goal not found` when they can't see the goal; 400 for another window). Docs: docs/projects-and-goals.md#progress.
 */
import { goalProgressQuerySchema } from '@/lib/server/goals/schema';
import { progressFor } from '@/lib/server/goals/progress';
import { visibleGoal } from '@/lib/server/goals/views';
import { error, handler, json, parseQuery } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (request: Request, { params }: Ctx) => {
  const query = parseQuery(request, goalProgressQuerySchema);
  if (!query.ok) return query.response;
  const actor = routeActor();
  const id = (await params).id;
  if (!visibleGoal(actor, id)) return error('Goal not found', 404);
  return json({ progress: progressFor(actor, [id], query.data.window) });
});
