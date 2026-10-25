/** PATCH/DELETE /api/folders/:id — rename or move a folder; delete it when it is empty. */
import { z } from 'zod';
import { FolderError, FolderNotEmptyError, folders } from '@/lib/server/folders';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const updateSchema = z.object({ name: z.string().optional(), parentId: z.string().nullable().optional() });

export const PATCH = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const body = await parseBody(request, updateSchema);
  if (!body.ok) return body.response;
  try {
    return json({ folder: folders.update(id, body.data) });
  } catch (caught) {
    if (caught instanceof FolderError) return error(caught.message, caught.status);
    throw caught;
  }
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  try {
    return folders.delete(id, store.listWorkflows()) ? json({ ok: true }) : error('Folder not found', 404);
  } catch (caught) {
    if (caught instanceof FolderNotEmptyError) return error(caught.message, 409, { folders: caught.folders, workflows: caught.workflows });
    throw caught;
  }
});
