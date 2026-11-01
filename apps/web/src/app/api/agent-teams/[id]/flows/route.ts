/**
 * GET /api/agent-teams/:id/flows — the workflows the caller sees that run this team (a Run a Team node set to it):
 * `{ flows: [{ id, name, active, nodes }] }`. "Save as template" on the team page picks one of them.
 */
import { agentTeamStore } from '@/lib/server/agent-teams/store';
import { error, handler, json } from '@/lib/server/http';
import { filterVisible } from '@/lib/server/projects';
import { routeActor } from '@/lib/server/projects/http';
import { store } from '@/lib/server/store';
import { runsTeam } from '@/lib/server/templates/team';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!agentTeamStore.get(id)) return error('Agent team not found', 404);
  const flows = filterVisible(routeActor(), 'workflow', store.listWorkflows().filter((w) => runsTeam(w, id)));
  return json({ flows: flows.map((w) => ({ id: w.id, name: w.name, active: Boolean(w.active), nodes: w.nodes.length })) });
});
