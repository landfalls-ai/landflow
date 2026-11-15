/**
 * GET /api/projects/:id — a project with its members (its members, owners and admins).
 * PATCH { name?, description?, icon?, brief?: { brief?, constraints?, doneWhen?, glossary?, status?, targetDate?, leadId?, decisionOwnerId? } } — rename a
 * team project and set its brief (null clears a field; its admins). `project.brief` carries the brief and its goals (docs/projects-and-goals.md).
 * DELETE ?transferTo=<projectId> (or body { transferTo }) — delete a team project (its admins); what it owns moves to
 * `transferTo`, where the caller must be an editor, in one transaction (required when it owns anything).
 */
import { z } from 'zod';
import { projectRoleCan } from '@/lib/shared/projects';
import { briefPatchSchema } from '@/lib/server/goals/schema';
import { error, json, parseBody } from '@/lib/server/http';
import { deleteProjectWithTransfer, getProject, projectRole, updateProject, updateProjectBrief } from '@/lib/server/projects';
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

const patchSchema = z.object({ name: z.string().max(120).optional(), description: z.string().max(500).nullable().optional(), icon: z.string().max(40).nullable().optional(), brief: briefPatchSchema.optional() });

export const PATCH = projectRoute(async (request: Request, { params }: Ctx) => {
  const actor = routeActor();
  const project = getProject((await params).id);
  const role = project && projectRole(actor, project.id);
  if (!project || !role) return error('Project not found', 404);
  if (!projectRoleCan.manage(role)) return error('Only the project’s admins can change it', 403);
  const body = await parseBody(request, patchSchema);
  if (!body.ok) return body.response;
  const { brief, ...rename } = body.data;
  // Check the brief first (a lead who isn't a member answers 400) so a bad brief doesn't leave the rename half done.
  if (brief) updateProjectBrief(project.id, brief);
  return json({ project: projectDetail(Object.keys(rename).length ? updateProject(project.id, rename) : (getProject(project.id) ?? project), actor) });
});

export const DELETE = projectRoute(async (request: Request, { params }: Ctx) => {
  const actor = routeActor();
  const project = getProject((await params).id);
  const role = project && projectRole(actor, project.id);
  if (!project || !role) return error('Project not found', 404);
  if (!projectRoleCan.manage(role)) return error('Only the project’s admins can delete it', 403);
  let transferTo = new URL(request.url).searchParams.get('transferTo') ?? undefined;
  if (!transferTo && request.headers.get('content-type')?.includes('json')) {
    const body = await parseBody(request, z.object({ transferTo: z.unknown().optional() }).passthrough(), { optional: true });
    if (!body.ok) return body.response;
    if (typeof body.data.transferTo === 'string') transferTo = body.data.transferTo;
  }
  if (transferTo && !projectRoleCan.create(projectRole(actor, transferTo))) return error('You can’t move things into that project', 403);
  return json({ ok: true, ...deleteProjectWithTransfer(project.id, transferTo, actor.id) });
});
