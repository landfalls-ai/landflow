/**
 * PUT /api/projects/:id/members { members: [{ userId, role: admin | editor | viewer }] } — replace a team project's
 * members (its admins, owners and admins). Memberships single sign-on or SCIM manage keep their source while their
 * role doesn't change.
 */
import { z } from 'zod';
import { PROJECT_ROLES, projectRoleCan } from '@/lib/shared/projects';
import { getUser } from '@/lib/server/auth';
import { error, json, parseBody } from '@/lib/server/http';
import { getProject, projectRole, replaceMembers } from '@/lib/server/projects';
import { projectRoute, routeActor } from '@/lib/server/projects/http';
import { projectDetail } from '@/lib/server/projects/views';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const schema = z.object({ members: z.array(z.object({ userId: z.string().min(1), role: z.enum(PROJECT_ROLES) })).max(1000) });

export const PUT = projectRoute(async (request: Request, { params }: Ctx) => {
  const actor = routeActor();
  const project = getProject((await params).id);
  const role = project && projectRole(actor, project.id);
  if (!project || !role) return error('Project not found', 404);
  if (!projectRoleCan.manage(role)) return error('Only the project’s admins can change its members', 403);
  if (project.type === 'personal') return error('A personal project has one member: share with them instead');
  const body = await parseBody(request, schema);
  if (!body.ok) return body.response;
  const missing = body.data.members.find((m) => !getUser(m.userId));
  if (missing) return error(`User ${missing.userId} not found`, 404);
  replaceMembers(project.id, body.data.members);
  return json({ project: projectDetail(project, actor) });
});
