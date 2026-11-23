/**
 * A project variable's per-environment values: GET `{ key, values: { env: value } }` (the project's members); PUT
 * `{ values: { env: value | null } }` (its editors and admins) sets (or, with null, removes) values and leaves the other
 * environments alone. On an instance whose LANDFLOW_ENVIRONMENT has a value, `$vars.KEY` reads it instead.
 */
import { z } from 'zod';
import { error, json, parseBody } from '@/lib/server/http';
import { projectRoute, requireProject, routeActor } from '@/lib/server/projects/http';
import { projectVariables } from '@/lib/server/projects/variables';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; key: string }> };

export const GET = projectRoute(async (_request: Request, { params }: Ctx) => {
  const { id, key } = await params;
  const project = requireProject(routeActor(), id, 'read');
  return projectVariables.get(project.id, key) ? json({ key, values: projectVariables.environments.of(project.id, key) }) : error('Variable not found', 404);
});

export const PUT = projectRoute(async (request: Request, { params }: Ctx) => {
  const { id, key } = await params;
  const project = requireProject(routeActor(), id, 'edit');
  const body = await parseBody(request, z.strictObject({ values: z.record(z.string(), z.string().nullable()) }));
  if (!body.ok) return body.response;
  if (!projectVariables.get(project.id, key)) return error('Variable not found', 404);
  return json({ key, values: projectVariables.environments.set(project.id, key, body.data.values) });
});
