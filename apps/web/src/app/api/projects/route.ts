/**
 * GET /api/projects — the projects the caller sees (their personal project and the team projects they belong to;
 * owners and admins: all), with their role, member count and what each owns. `?targets=1` instead lists every team
 * project and user's personal project by name, to share with or move to.
 * POST { name, description?, members?: [{ userId, role }] } — a team project (owners and admins).
 */
import { z } from 'zod';
import { PROJECT_ROLES } from '@/lib/shared/projects';
import { requireUser } from '@/lib/server/auth';
import { json, parseBody } from '@/lib/server/http';
import { createTeamProject, listProjects, setMember } from '@/lib/server/projects';
import { projectRoute, routeActor } from '@/lib/server/projects/http';
import { projectDetail, visibleProjects } from '@/lib/server/projects/views';
import { authDb } from '@/lib/server/auth/db';

export const dynamic = 'force-dynamic';

export const GET = projectRoute(async (request: Request) => {
  const actor = routeActor();
  if (new URL(request.url).searchParams.get('targets')) {
    return json({ projects: listProjects().map((p) => ({ id: p.id, name: p.name, type: p.type, ...(p.ownerId && { ownerId: p.ownerId }) })) });
  }
  return json({ projects: visibleProjects(actor) });
});

const createSchema = z.object({
  name: z.string().trim().min(1, 'Give the project a name').max(120),
  description: z.string().max(500).optional(),
  icon: z.string().max(40).optional(),
  members: z.array(z.object({ userId: z.string().min(1), role: z.enum(PROJECT_ROLES) })).max(500).optional(),
});

export const POST = projectRoute(async (request: Request) => {
  const actor = await requireUser('projects:manage');
  const body = await parseBody(request, createSchema);
  if (!body.ok) return body.response;
  const project = authDb().transaction(() => {
    const created = createTeamProject({ ...body.data, createdBy: actor.id });
    for (const member of body.data.members ?? []) setMember(created.id, member.userId, member.role);
    return created;
  });
  return json({ project: projectDetail(project, actor) }, 201);
});
