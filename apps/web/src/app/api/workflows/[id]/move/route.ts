/**
 * POST /api/workflows/:id/move — `{ folderId }` puts the workflow in a folder of its own project; `null` moves it to
 * the top level. (Moving it to another project is `/transfer`.)
 */
import { z } from 'zod';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { homeProjectId } from '@/lib/server/projects';
import { folderProblem } from '@/lib/server/projects/folders';
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
  const problem = folderId ? folderProblem(folderId, homeProjectId('workflow', id)) : undefined;
  if (problem) return error(problem.message, problem.status);
  const { folderId: _previous, ...rest } = workflow;
  return json({ workflow: store.saveWorkflow(folderId ? { ...rest, folderId } : rest) });
});
