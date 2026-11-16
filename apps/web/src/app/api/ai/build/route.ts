import { z } from 'zod';
import { registry } from '@/lib/server/plugins/registry';
import { guardDraft } from '@/lib/server/assistant/draft-guards';
import { roster } from '@/lib/server/assistant/roster';
import { allowedTypes } from '@/lib/server/assistant/scope';
import { describeAgents } from '@/lib/shared/agent-brief';
import { describeTeams } from '@/lib/shared/agent-teams';
import { buildFlow } from '@/lib/server/flow-builder';
import { assistantScope, runInUsageScope } from '@/lib/server/ai-usage'; // SB19:
import { resolveSpotlightModel } from '@/lib/server/assistant/models-list'; // SB19:
import { currentPrincipal } from '@/lib/server/auth/guard'; // SB19:
import { meteredWorkflowId } from '@/lib/server/assistant/scope'; // SB19:
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

const Body = z.object({ prompt: z.string().trim().min(3).max(2000), model: z.string().max(100).optional(), workflowId: z.string().max(64).optional() });

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
    const draft = await runInUsageScope(scope, () => buildFlow(parsed.data.prompt, picked.model, teams, agents, { types }));
    const byType = new Map(types.map((t) => [t.type, t]));
    const credentialNames = new Map(registry.credentialTypes().flatMap((c) => [[c.descriptor.name, c.descriptor.displayName], [c.type, c.descriptor.displayName]] as const));
    const known = [parsed.data.prompt, agents.length ? describeAgents(agents) : '', teams.length ? describeTeams([...teams]) : ''].join('\n');
    return json({ draft: guardDraft(draft, { prompt: parsed.data.prompt, known, byType: (type) => byType.get(type), credentialName: (name) => credentialNames.get(name) }) });
  } catch (e) {
    return error((e as Error).message, 502);
  }
});
