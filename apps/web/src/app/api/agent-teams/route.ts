import { teamConfigSchema } from '@/lib/server/agent-teams/http';
import { agentTeamStore } from '@/lib/server/agent-teams/store';
import { handler, json, parseBody } from '@/lib/server/http';
import { withOwnership } from '@/lib/server/projects';
import { createInProject, projectParam, routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

/** GET ?projectId= — the teams the caller sees, each with its `ownership` and which of the agents it is made of. */
export const GET = handler(async (request: Request) => json({ teams: withOwnership(routeActor(), 'agentTeam', agentTeamStore.summaries(), projectParam(request)) }));

/** POST — a new team (empty, or with the draft given) in the requested project. */
export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, teamConfigSchema);
  if (!body.ok) return body.response;
  const actor = routeActor();
  const team = createInProject(request, 'agentTeam', () => agentTeamStore.create(body.data as never, actor.id), (t) => t.id);
  return json({ team }, 201);
});
