import { agentTeamStore, issuesOf } from '@/lib/server/agent-teams/store';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { ownershipOf } from '@/lib/server/projects';
import { forgetDeleted, routeActor } from '@/lib/server/projects/http';
import { teamConfigSchema } from '@/lib/server/agent-teams/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** GET — the team with its `ownership` and `issues`: what stops the draft from being published. */
export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const team = agentTeamStore.get((await params).id);
  return team ? json({ team, issues: issuesOf(team.draft), ownership: ownershipOf(routeActor(), 'agentTeam', team.id) }) : error('Agent team not found', 404);
});

/** PUT — replaces the draft (autosave); the published version stays as it is. */
export const PUT = handler(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, teamConfigSchema);
  if (!body.ok) return body.response;
  const team = agentTeamStore.saveDraft((await params).id, body.data as never);
  return team ? json({ team, issues: issuesOf(team.draft) }) : error('Agent team not found', 404);
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!agentTeamStore.delete(id)) return error('Agent team not found', 404);
  forgetDeleted('agentTeam', id);
  return json({ ok: true });
});
