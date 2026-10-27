/**
 * POST /api/workflows/:id/git-history/:commit/restore `{ path }` — save the workflow as that commit has it as a new draft
 * (a version in its history). Nothing is published; its folder and activation stay. Credentials are matched by name and type.
 * 403 in a protected environment, like any workflow change.
 */
import { z } from 'zod';
import { recordAudit } from '@/lib/server/audit';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { restoreWorkflowFromCommit, SourceControlError } from '@/lib/server/sync/git';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; commit: string }> };

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id, commit } = await params;
  const body = await parseBody(request, z.object({ path: z.string().min(1).max(1000) }));
  if (!body.ok) return body.response;
  try {
    const result = await restoreWorkflowFromCommit(id, commit, body.data.path);
    recordAudit({ action: 'workflow.update', target: { type: 'workflow', id, name: result.workflow.name }, summary: `Restored “${result.workflow.name}” from Git commit ${commit.slice(0, 7)}`, details: { commit, path: body.data.path } });
    return json(result);
  } catch (caught) {
    if (caught instanceof SourceControlError) return error(caught.message, caught.status);
    throw caught;
  }
});
