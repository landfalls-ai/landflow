/**
 * POST { action: 'resume' | 'raise' | 'dismiss', monthlyUsd? } — what a person does with one of the project's AI budget
 * incidents this month (docs/projects-and-goals.md#ai-budget). Answers the new `ProjectBudgetView`.
 */
import { z } from 'zod';
import { aiUsageMeter } from '@/lib/server/ai-usage';
import { actOnIncident } from '@/lib/server/budgets/enforce';
import { budgetViewFor } from '@/lib/server/budgets/view';
import { json, parseBody } from '@/lib/server/http';
import { projectRoute, requireProject, routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; incidentId: string }> };

const actionSchema = z.discriminatedUnion('action', [z.object({ action: z.literal('resume') }), z.object({ action: z.literal('raise'), monthlyUsd: z.number().positive() }), z.object({ action: z.literal('dismiss') })]);

export const POST = projectRoute(async (request: Request, { params }: Ctx) => {
  const actor = routeActor();
  const { id, incidentId } = await params;
  const project = requireProject(actor, id, 'read');
  const body = await parseBody(request, actionSchema);
  if (!body.ok) return body.response;
  actOnIncident(aiUsageMeter(), project, incidentId, body.data, actor);
  return json(budgetViewFor(aiUsageMeter(), actor, project.id));
});
