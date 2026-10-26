/**
 * One project variable: GET (the project's members), PATCH { value?, key? } (a new `key` renames it) and DELETE (the
 * project's editors and admins).
 */
import { z } from 'zod';
import { error, json, parseBody } from '@/lib/server/http';
import { projectRoute, requireProject, routeActor } from '@/lib/server/projects/http';
import { projectVariables } from '@/lib/server/projects/variables';
import { VariableError } from '@/lib/server/variables';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; key: string }> };

export const GET = projectRoute(async (_request: Request, { params }: Ctx) => {
  const { id, key } = await params;
  const project = requireProject(routeActor(), id, 'read');
  const variable = projectVariables.get(project.id, key);
  return variable ? json(variable) : error('Variable not found', 404);
});

export const PATCH = projectRoute(async (request: Request, { params }: Ctx) => {
  const { id, key } = await params;
  const project = requireProject(routeActor(), id, 'edit');
  const body = await parseBody(request, z.object({ key: z.string().optional(), value: z.string().optional() }));
  if (!body.ok) return body.response;
  try {
    return json(projectVariables.update(project.id, key, body.data));
  } catch (caught) {
    if (caught instanceof VariableError) return error(caught.message, caught.status);
    throw caught;
  }
});

export const DELETE = projectRoute(async (_request: Request, { params }: Ctx) => {
  const { id, key } = await params;
  const project = requireProject(routeActor(), id, 'edit');
  return projectVariables.delete(project.id, key) ? json({ ok: true }) : error('Variable not found', 404);
});
