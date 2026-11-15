/**
 * GET /api/goals/:id — a goal with its chain of parents (404 when the caller can't see it).
 * PATCH { title?, why?|null, status?, ownerId?|null, targetDate?|null, parentId?|null } — change it.
 * DELETE — delete it (409 `goal_has_children` while it has sub-goals). Docs: docs/projects-and-goals.md.
 */
import { updateGoalSchema } from '@/lib/server/goals/schema';
import { deleteGoalAs, goalDetail, goalView, updateGoalAs } from '@/lib/server/goals/views';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const detail = goalDetail(routeActor(), (await params).id);
  return detail ? json(detail) : error('Goal not found', 404);
});

export const PATCH = handler(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, updateGoalSchema);
  if (!body.ok) return body.response;
  const actor = routeActor();
  return json({ goal: goalView(actor, updateGoalAs(actor, (await params).id, body.data)) });
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  deleteGoalAs(routeActor(), (await params).id);
  return json({ ok: true });
});
