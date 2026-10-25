/**
 * GET /api/sync/export — the instance as Git sync files (lib/server/sync/format.ts): `{ format, files: [{ path,
 * content, hash }], hashes, summary }`. `?values=true` writes variable values; `?workflow=<id>` (repeatable) limits
 * the workflow files to those workflows and their folders. The CLI's `sync pull` and `export` use it.
 */
import { error, handler, json } from '@/lib/server/http';
import { store } from '@/lib/server/store';
import { exportState } from '@/lib/server/sync';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => {
  const params = new URL(request.url).searchParams;
  const workflowIds = params.getAll('workflow').filter(Boolean);
  const missing = workflowIds.find((id) => !store.getWorkflow(id));
  if (missing) return error(`Workflow ${missing} not found`, 404);
  const values = ['1', 'true', 'yes'].includes((params.get('values') ?? '').toLowerCase());
  return json(exportState({ values, ...(workflowIds.length && { workflowIds }) }));
});
