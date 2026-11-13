/**
 * GET /api/sync/export — the instance as Git sync files (lib/server/sync/format.ts): `{ format, files: [{ path,
 * content, hash }], hashes, summary }`. `?values=true` writes variable values; `?workflow=<id>` (repeatable) limits
 * the workflow files to those workflows and their folders. The CLI's `sync pull` and `export` use it.
 */
import { recordAudit } from '@/lib/server/audit';
import { error, handler, json } from '@/lib/server/http';
import { visibleIds } from '@/lib/server/projects';
import { routeActor } from '@/lib/server/projects/http';
import { store } from '@/lib/server/store';
import { exportState } from '@/lib/server/sync';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => {
  const params = new URL(request.url).searchParams;
  let workflowIds = params.getAll('workflow').filter(Boolean);
  // Members export the workflows they see (owners and admins: all).
  const visible = visibleIds(routeActor(), 'workflow', store.listWorkflows().map((w) => w.id));
  const missing = workflowIds.find((id) => !store.getWorkflow(id) || (visible && !visible.has(id)));
  if (missing) return error(`Workflow ${missing} not found`, 404);
  if (visible && !workflowIds.length) workflowIds = [...visible];
  const values = ['1', 'true', 'yes'].includes((params.get('values') ?? '').toLowerCase());
  const exported = exportState({ values, ...(workflowIds.length && { workflowIds }) });
  // What left and how much, never the files' content (`values` says whether variable values went with it).
  recordAudit({ action: 'sync.export', summary: `Exported ${exported.files.length} Git sync files${values ? ' with variable values' : ''}`, details: { files: exported.files.length, values, ...exported.summary, ...(workflowIds.length && { limitedToWorkflows: workflowIds.length }) } });
  return json(exported);
});
