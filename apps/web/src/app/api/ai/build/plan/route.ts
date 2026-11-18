import { roster } from '@/lib/server/assistant/roster';
import { allowedTypes, meteredWorkflowId } from '@/lib/server/assistant/scope';
import { planFlow } from '@/lib/server/assistant/build-plan';
import { assistantScope, isUsageCapError, runInUsageScope } from '@/lib/server/ai-usage';
import { resolveSpotlightModel } from '@/lib/server/assistant/models-list';
import { currentPrincipal } from '@/lib/server/auth/guard';
import type { BuildStage } from '@/lib/shared/build-plan';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { PlanBody } from '../plan-schema';

export const dynamic = 'force-dynamic';

/**
 * POST { prompt, model?, workflowId?, plan?, change? } → { plan, alternatives, stages, model }: stage 1 of a first draft
 * (docs/assistant.md "Building a flow in stages"). The model is told the node types the request's words found, not the
 * catalog. With `plan` and `change` (the person's correction), the corrected plan. Counted as Spotlight's own call
 * (surface `spotlight`, purpose `answer`), under the caller's caps.
 */
export const POST = handler(async (request: Request) => {
  const parsed = await parseBody(request, PlanBody);
  if (!parsed.ok) return parsed.response;
  const { prompt, workflowId: requested, plan, change } = parsed.data;
  if (change && !plan) return error('A change needs the plan it corrects', 400);
  const picked = await resolveSpotlightModel(parsed.data.model);
  if ('error' in picked) return error(picked.error, 400);
  try {
    const { agents, teams } = roster();
    const types = allowedTypes(requested);
    const userId = currentPrincipal()?.user?.id;
    const workflowId = meteredWorkflowId(requested);
    const scope = assistantScope({ surface: 'spotlight', ...(userId && { userId }), ...(workflowId && { workflowId }) });
    const stages: BuildStage[] = [];
    const result = await runInUsageScope(scope, () => planFlow(prompt, { model: picked.model, types, agents, teams, stages, ...(plan && { plan }), ...(change && { change }) }));
    // AG18: the build has no tool loop, so the roster is how it reads the tenant: said as a step of the build's trace, like chat's list_agents.
    const steps = [{ tool: 'list_agents', label: `Looked at ${agents.length} agent${agents.length === 1 ? '' : 's'}`, ok: true }];
    return json({ ...result, stages, steps, model: picked.model });
  } catch (e) {
    return error((e as Error).message, isUsageCapError(e) ? 429 : 502);
  }
});
