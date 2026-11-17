import { z } from 'zod';
import { registry } from '@/lib/server/plugins/registry';
import { guardDraft } from '@/lib/server/assistant/draft-guards';
import { roster } from '@/lib/server/assistant/roster';
import { allowedTypes } from '@/lib/server/assistant/scope';
import { describeAgents } from '@/lib/shared/agent-brief';
import { describeTeams } from '@/lib/shared/agent-teams';
import { buildFlow } from '@/lib/server/flow-builder';
import { CONNECTION_TYPES } from '@landflow/protocol'; // SB14:
import { draftSummary } from '@/lib/shared/draft-summary'; // SB15:
import { assistantScope, isUsageCapError, runInUsageScope } from '@/lib/server/ai-usage'; // SB19:
import { resolveSpotlightModel } from '@/lib/server/assistant/models-list'; // SB19:
import { currentPrincipal } from '@/lib/server/auth/guard'; // SB19:
import { meteredWorkflowId } from '@/lib/server/assistant/scope'; // SB19:
import { error, handler, json, parseBody } from '@/lib/server/http';
import { planProblems } from '@/lib/shared/build-plan'; // SB13:
import { subnodeProblems } from '@/lib/server/assistant/build-plan'; // SB13:
import { PlanSchema } from './plan-schema'; // SB13:

export const dynamic = 'force-dynamic';

// SB13: a plan the person agreed to (SB13's `BuildPlan`); SB14: it builds stage 2, one call per step.
const Body = z.object({ prompt: z.string().trim().min(3).max(2000), model: z.string().max(100).optional(), workflowId: z.string().max(64).optional(), plan: PlanSchema.optional() /* SB13: */, staged: z.boolean().optional() /* sb3 integration: false = the one-shot draft */ });

/** POST { prompt, workflowId? } → a validated flow draft from the local model, guarded as the chat guards a proposal. */
export const POST = handler(async (request: Request) => {
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  const picked = await resolveSpotlightModel(parsed.data.model); // SB19:
  if ('error' in picked) return error(picked.error, 400); // SB19:
  try {
    // The published agents and teams the caller can see, as Spotlight's chat gets them: a step that needs an agent runs
    // one of them when one fits, and Run an Agent and Run a Team need real ones.
    const { agents, teams } = roster();
    // The node types the workflow may use (the chat's filter): the model is not offered one its policy blocks.
    const types = allowedTypes(parsed.data.workflowId);
    // SB19: the draft is Spotlight's call: counted under surface `spotlight`, and the caller's caps apply.
    const userId = currentPrincipal()?.user?.id;
    const workflowId = meteredWorkflowId(parsed.data.workflowId);
    const scope = assistantScope({ surface: 'spotlight', ...(userId && { userId }), ...(workflowId && { workflowId }) });
    // SB13: a plan the person agreed to is checked against the types this workflow may use before anything is built.
    const { plan } = parsed.data;
    if (plan) {
      const offered = new Map(types.map((t) => [t.type, t]));
      // SB14: an attached step names a sub-node connection (never `main`).
      const attachProblems = plan.steps.flatMap((s) => (s.attach && (s.attach === 'main' || !(CONNECTION_TYPES as readonly string[]).includes(s.attach)) ? [{ step: s.key, problem: `“${s.attach}” is not a sub-node connection` }] : []));
      const problems = [...planProblems(plan, new Set(offered.keys()), (type) => offered.get(type)?.descriptor.kind === 'trigger'), ...subnodeProblems(plan, (type) => offered.get(type)), ...attachProblems];
      if (problems.length) return error(`The plan cannot be built: ${problems.map((p) => `${p.step ? `${p.step}: ` : ''}${p.problem}`).join('; ')}`, 400);
    }
    const draft = await runInUsageScope(scope, () => buildFlow(parsed.data.prompt, picked.model, teams, agents, { types, ...(plan && { plan }) /* SB13: */, ...(parsed.data.staged === false && { staged: false }) }));
    const byType = new Map(types.map((t) => [t.type, t]));
    const credentialNames = new Map(registry.credentialTypes().flatMap((c) => [[c.descriptor.name, c.descriptor.displayName], [c.type, c.descriptor.displayName]] as const));
    const known = [parsed.data.prompt, agents.length ? describeAgents(agents) : '', teams.length ? describeTeams([...teams]) : ''].join('\n');
    const guarded = guardDraft(draft, { prompt: parsed.data.prompt, known, byType: (type) => byType.get(type), credentialName: (name) => credentialNames.get(name) });
    return json({ draft: { ...guarded, summary: draftSummary(guarded, (type) => byType.get(type)?.descriptor.displayName ?? type) } }); // SB15:
  } catch (e) {
    // The caller's AI cap, as the design route answers it: 429, not a 502 from the model.
    return error((e as Error).message, isUsageCapError(e) ? 429 : 502);
  }
});
