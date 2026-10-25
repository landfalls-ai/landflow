/**
 * GET /api/projects/:id — a project with its members (its members, owners and admins).
 * PATCH { name?, description?, icon? } — rename a team project (its admins).
 * DELETE ?transferTo=<projectId> (or body { transferTo }) — delete a team project (its admins); what it owns moves to
 * `transferTo`, where the caller must be an editor, in one transaction (required when it owns anything).
 */
import { z } from 'zod';
import { projectRoleCan } from '@/lib/shared/projects';
import { error, json, parseBody } from '@/lib/server/http';
import { deleteProjectWithTransfer, getProject, projectRole, updateProject } from '@/lib/server/projects';
import { projectRoute, routeActor } from '@/lib/server/projects/http';
import { projectDetail } from '@/lib/server/projects/views';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = projectRoute(async (_request: Request, { params }: Ctx) => {
  const actor = routeActor();
  const project = getProject((await params).id);
  if (!project || !projectRole(actor, project.id)) return error('Project not found', 404);
  return json({ project: projectDetail(project, actor) });
});

const patchSchema = z.object({ name: z.string().max(120).optional(), description: z.string().max(500).nullable().optional(), icon: z.string().max(40).nullable().optional() });

export const PATCH = projectRoute(async (request: Request, { params }: Ctx) => {
  const actor = routeActor();
  const project = getProject((await params).id);
  const role = project && projectRole(actor, project.id);
  if (!project || !role) return error('Project not found', 404);
  if (!projectRoleCan.manage(role)) return error('Only the project’s admins can change it', 403);
  const body = await parseBody(request, patchSchema);
  if (!body.ok) return body.response;
  return json({ project: projectDetail(updateProject(project.id, body.data), actor) });
});

export const DELETE = projectRoute(async (request: Request, { params }: Ctx) => {
  const actor = routeActor();
  const project = getProject((await params).id);
  const role = project && projectRole(actor, project.id);
  if (!project || !role) return error('Project not found', 404);
  if (!projectRoleCan.manage(role)) return error('Only the project’s admins can delete it', 403);
  let transferTo = new URL(request.url).searchParams.get('transferTo') ?? undefined;
  if (!transferTo && request.headers.get('content-type')?.includes('json')) {
    const body = (await request.json().catch(() => ({}))) as { transferTo?: unknown };
    if (typeof body.transferTo === 'string') transferTo = body.transferTo;
  }
  if (transferTo && !projectRoleCan.create(projectRole(actor, transferTo))) return error('You can’t move things into that project', 403);
  return json({ ok: true, ...deleteProjectWithTransfer(project.id, transferTo, actor.id) });
});
