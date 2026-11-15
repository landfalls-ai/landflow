/**
 * GET /api/agents/:id/shares — where the agent is available: its home project, the projects it is shared with (only the
 * ones the caller has a role in) and whether it is shared with all projects. PUT { projectIds, all } replaces the shares
 * (admins of its home project, owners and admins). A share lets a project use the agent; the home still decides who edits it.
 */
import { z } from 'zod';
import { agentStore } from '@/lib/server/agents/store';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { projectRole } from '@/lib/server/projects/access';
import { routeActor, shareViews } from '@/lib/server/projects/http';
import { getProject, homeProjectId, replaceShares, shares } from '@/lib/server/projects/store';
import { ALL_PROJECTS, type AgentAvailability } from '@/lib/shared/projects';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  projectIds: z.array(z.string().min(1).max(200)).max(100).refine((ids) => new Set(ids).size === ids.length, 'Each project once'),
  all: z.boolean(),
});

/** The answer: the availability (projects the caller has no role in are left out) and the share rows. */
function answer(id: string) {
  const actor = routeActor();
  const home = getProject(homeProjectId('agent', id) ?? '');
  const rows = shares('agent', id);
  const all = rows.some((row) => row.projectId === ALL_PROJECTS);
  const projects = all
    ? []
    : rows
        .flatMap((row) => {
          const project = getProject(row.projectId);
          return project && projectRole(actor, project.id) ? [{ id: project.id, name: project.name }] : [];
        })
        .sort((a, b) => a.name.localeCompare(b.name));
  const availability: AgentAvailability = { home: { id: home?.id ?? '', name: home?.name ?? 'Default' }, all, projects };
  return { availability, shares: shareViews('agent', id) };
}

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!agentStore.get(id)) return error('Agent not found', 404);
  return json(answer(id));
});

export const PUT = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!agentStore.get(id)) return error('Agent not found', 404);
  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  const home = homeProjectId('agent', id);
  const wanted: Array<{ projectId: string; role: 'user' }> = [];
  for (const projectId of body.data.projectIds) {
    if (projectId === ALL_PROJECTS || !getProject(projectId)) return error('Project not found', 404);
    if (projectId !== home) wanted.push({ projectId, role: 'user' });
  }
  // "All projects" covers every project, so single rows are not kept beside it.
  replaceShares('agent', id, body.data.all ? [{ projectId: ALL_PROJECTS, role: 'user' }] : wanted, routeActor().id);
  return json(answer(id));
});
