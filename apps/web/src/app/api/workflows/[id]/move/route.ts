/** POST /api/workflows/:id/move — `{ folderId }` puts the workflow in a folder; `null` moves it to the top level. */
import { z } from 'zod';
import { folders } from '@/lib/server/folders';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const moveSchema = z.object({ folderId: z.string().nullable() });

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const workflow = store.getWorkflow(id);
  if (!workflow) return error('Workflow not found', 404);
  const body = await parseBody(request, moveSchema);
  if (!body.ok) return body.response;
  const { folderId } = body.data;
  if (folderId && !folders.get(folderId)) return error('Folder not found', 404);
  const { folderId: _previous, ...rest } = workflow;
  return json({ workflow: store.saveWorkflow(folderId ? { ...rest, folderId } : rest) });
});
