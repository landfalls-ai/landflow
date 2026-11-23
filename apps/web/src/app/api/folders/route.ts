/**
 * GET/POST /api/folders — folders of the workflows list. Folders belong to a project: GET `?projectId=` lists that
 * project's folders (else those of every project the caller sees), POST makes a top-level folder in `?projectId=` (or
 * the body's `projectId`, else the caller's personal project; the caller must be an editor there) and a subfolder in
 * its parent's project.
 */
import { z } from 'zod';
import { folders } from '@/lib/server/folders';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { creationProject, projectRole, visibleProjectIds } from '@/lib/server/projects';
import { folderViews, requireFolder } from '@/lib/server/projects/folders';
import { projectParam, routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

const createSchema = z.object({ name: z.string(), parentId: z.string().optional(), projectId: z.string().optional() });

export const GET = handler(async (request: Request) => {
  const actor = routeActor();
  const projectId = projectParam(request);
  if (projectId) {
    if (!projectRole(actor, projectId)) return error('Project not found', 404);
    return json({ folders: folderViews(folders.listIn(projectId)) });
  }
  const visible = visibleProjectIds(actor);
  return json({ folders: folderViews(visible ? folders.listIn(visible) : folders.list()) });
});

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, createSchema);
  if (!body.ok) return body.response;
  const actor = routeActor();
  const { projectId: requested, ...input } = body.data;
  // A subfolder goes to its parent's project (the caller must be an editor there).
  const projectId = input.parentId ? requireFolder(actor, input.parentId, 'edit').projectId : creationProject(actor, projectParam(request) ?? requested);
  return json({ folder: folderViews([folders.create({ ...input, ...(projectId && { projectId }) })])[0] }, 201);
});
