import { z } from 'zod';
import { agentTeamStore } from '@/lib/server/agent-teams/store';
import { buildFlow } from '@/lib/server/flow-builder';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { withOwnership } from '@/lib/server/projects';
import { routeActor } from '@/lib/server/projects/http';
import { teamBrief } from '@/lib/shared/agent-teams';

export const dynamic = 'force-dynamic';

const Body = z.object({ prompt: z.string().trim().min(3).max(2000), model: z.string().max(100).optional() });

/** POST { prompt } → a validated flow draft from the local model. */
export const POST = handler(async (request: Request) => {
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  try {
    // The published teams the caller can see, as Spotlight's chat gets them: a Run a Team node needs a real one.
    const visible = new Set(withOwnership(routeActor(), 'agentTeam', agentTeamStore.summaries()).map((t) => t.id));
    const teams = agentTeamStore.list().filter((t) => visible.has(t.id)).flatMap((t) => teamBrief(t) ?? []).slice(0, 20);
    return json({ draft: await buildFlow(parsed.data.prompt, parsed.data.model, teams) });
  } catch (e) {
    return error((e as Error).message, 502);
  }
});
