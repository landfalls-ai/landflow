/**
 * A project's variables (`$vars` in its workflows, read before the instance's):
 * GET  — `{ variables: [{ key, value }], environments: { KEY: { env: value } }, canEdit }` (the project's members).
 * POST { key, value } — add one (the project's editors and admins).
 */
import { z } from 'zod';
import { json, parseBody } from '@/lib/server/http';
import { projectRoleCan } from '@/lib/shared/projects';
import { projectRoute, requireProject, routeActor } from '@/lib/server/projects/http';
import { projectVariables } from '@/lib/server/projects/variables';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = projectRoute(async (_request: Request, { params }: Ctx) => {
  const project = requireProject(routeActor(), (await params).id, 'read');
  return json({ variables: projectVariables.list(project.id), environments: projectVariables.environments.all(project.id), canEdit: projectRoleCan.create(project.role) });
});

export const POST = projectRoute(async (request: Request, { params }: Ctx) => {
  const project = requireProject(routeActor(), (await params).id, 'edit');
  const body = await parseBody(request, z.object({ key: z.string(), value: z.string() }));
  if (!body.ok) return body.response;
  return json(projectVariables.create(project.id, body.data), 201);
});
