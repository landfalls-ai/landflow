import { z } from 'zod';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { canResource, homeProjectId, projectRole } from '@/lib/server/projects';
import { routeActor } from '@/lib/server/projects/http';
import { projectVariables } from '@/lib/server/projects/variables';
import { variables } from '@/lib/server/variables';

export const dynamic = 'force-dynamic';

/**
 * `[{ key, value }]`, sorted by key: the instance's variables (also what the expression editor suggests after `$vars.`).
 * With `?workflowId=` (or `?projectId=`), what `$vars` sees there: that project's variables (marked `projectId`) over
 * the instance's. Instance variables are changed here (owners and admins); a project's under /api/projects/<id>/variables.
 */
export const GET = handler(async (request: Request) => {
  const params = new URL(request.url).searchParams;
  const workflowId = params.get('workflowId');
  const actor = routeActor();
  let projectId = params.get('projectId') ?? undefined;
  if (projectId && !projectRole(actor, projectId)) return error('Project not found', 404);
  if (!projectId && workflowId) {
    if (!canResource(actor, 'workflow', workflowId, 'read')) return error('Workflow not found', 404);
    projectId = homeProjectId('workflow', workflowId);
  }
  if (!projectId) return json(variables.list());
  const merged = new Map<string, { key: string; value: string; projectId?: string }>(variables.list().map((v) => [v.key, v]));
  for (const variable of projectVariables.list(projectId)) merged.set(variable.key, { ...variable, projectId });
  return json([...merged.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)));
});

/** POST { key, value } */
export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, z.object({ key: z.string(), value: z.string() }));
  if (!body.ok) return body.response;
  return json(variables.create(body.data), 201);
});
