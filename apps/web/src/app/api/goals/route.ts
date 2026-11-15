/**
 * GET /api/goals?projectId=&status= — the goals the caller sees, as a tree, with the company mission.
 * POST /api/goals { title, why?, level, status?, ownerId?, targetDate?, parentId?, projectId?, projectIds? } — add a goal
 * (company goals: owners and admins; project goals: the project's admins). Docs: docs/projects-and-goals.md.
 */
import { createGoalSchema, goalsQuerySchema } from '@/lib/server/goals/schema';
import { createGoalAs, goalsResponse, goalView } from '@/lib/server/goals/views';
import { handler, json, parseBody, parseQuery } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => {
  const query = parseQuery(request, goalsQuerySchema);
  if (!query.ok) return query.response;
  return json(goalsResponse(routeActor(), query.data));
});

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, createGoalSchema);
  if (!body.ok) return body.response;
  const actor = routeActor();
  return json({ goal: goalView(actor, createGoalAs(actor, body.data)) }, { status: 201 });
});
