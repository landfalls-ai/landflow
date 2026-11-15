/**
 * A project's monthly AI budget (docs/projects-and-goals.md#ai-budget; lib/server/budgets).
 * GET — the `ProjectBudgetView` (any role in the project).
 * PUT { monthlyUsd, warnPercent?, hardStop?, ownerId? } — the project's admins (and instance owners and admins); 0 removes the budget.
 */
import { z } from 'zod';
import { aiUsageMeter } from '@/lib/server/ai-usage';
import { budgetViewFor } from '@/lib/server/budgets/view';
import { putBudget, BudgetError } from '@/lib/server/budgets/enforce';
import { json, parseBody } from '@/lib/server/http';
import { projectRoute, requireProject, routeActor } from '@/lib/server/projects/http';
import { BUDGET_MAX_USD } from '@/lib/shared/project-budget';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const inputSchema = z.object({
  monthlyUsd: z.number().min(0).max(BUDGET_MAX_USD),
  warnPercent: z.number().int().min(1).max(100).optional(),
  hardStop: z.boolean().optional(),
  ownerId: z.string().min(1).nullable().optional(),
});

export const GET = projectRoute(async (_request: Request, { params }: Ctx) => {
  const actor = routeActor();
  const project = requireProject(actor, (await params).id, 'read');
  return json(budgetViewFor(aiUsageMeter(), actor, project.id));
});

export const PUT = projectRoute(async (request: Request, { params }: Ctx) => {
  const actor = routeActor();
  const project = requireProject(actor, (await params).id, 'read');
  if (project.role !== 'admin') throw new BudgetError('Only the project’s admins change its AI budget', 403);
  const body = await parseBody(request, inputSchema);
  if (!body.ok) return body.response;
  putBudget(aiUsageMeter(), project, body.data, actor);
  return json(budgetViewFor(aiUsageMeter(), actor, project.id));
});
