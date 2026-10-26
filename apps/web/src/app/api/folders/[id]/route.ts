/**
 * PATCH/DELETE /api/folders/:id — rename or move a folder (within its project); delete it when it is empty. Editors
 * and admins of the folder's project only.
 */
import { z } from 'zod';
import { FolderError, FolderNotEmptyError, folders } from '@/lib/server/folders';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { defaultProjectId, homeProjects } from '@/lib/server/projects';
import { folderViews, requireFolder } from '@/lib/server/projects/folders';
import { routeActor } from '@/lib/server/projects/http';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const updateSchema = z.object({ name: z.string().optional(), parentId: z.string().nullable().optional() });

export const PATCH = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const body = await parseBody(request, updateSchema);
  if (!body.ok) return body.response;
  try {
    requireFolder(routeActor(), id, 'edit');
    if (body.data.parentId) requireFolder(routeActor(), body.data.parentId, 'edit');
    return json({ folder: folderViews([folders.update(id, body.data)])[0] });
  } catch (caught) {
    if (caught instanceof FolderError) return error(caught.message, caught.status);
    throw caught;
  }
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!folders.get(id)) return error('Folder not found', 404);
  const { projectId } = requireFolder(routeActor(), id, 'edit');
  // Workflows of other projects still pointing here (from before folders had projects) show at their project's top level.
  const homes = homeProjects('workflow');
  const fallback = defaultProjectId();
  const inProject = store.listWorkflows().filter((w) => (homes.get(w.id) ?? fallback) === projectId);
  try {
    return folders.delete(id, inProject) ? json({ ok: true }) : error('Folder not found', 404);
  } catch (caught) {
    if (caught instanceof FolderNotEmptyError) return error(caught.message, 409, { folders: caught.folders, workflows: caught.workflows });
    throw caught;
  }
});
