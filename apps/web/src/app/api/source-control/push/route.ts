/**
 * POST /api/source-control/push — `{ message?, dryRun?, workflowIds? }`: export the instance into the working copy, commit and
 * push the branch → `{ committed, commit, branch, files }`. A dry run reports what the commit would hold. With `workflowIds` only
 * those workflows (and their folders) are committed; everything else on the branch stays as it is.
 */
import { z } from 'zod';
import { handler, json, parseBody } from '@/lib/server/http';
import { pushToRepository } from '@/lib/server/sync/git';
import { recordAudit } from '@/lib/server/audit';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ message: z.string().max(5000).optional(), dryRun: z.boolean().default(false), workflowIds: z.array(z.string().min(1).max(200)).max(500).optional() });

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  const result = await pushToRepository(body.data);
  if (!result.dryRun) recordAudit({ action: 'source_control.push', target: { type: 'repository', name: result.branch }, summary: result.committed ? `Pushed ${result.files.length} file change${result.files.length === 1 ? '' : 's'} to ${result.branch}` : `Pushed to ${result.branch}: nothing to commit`, details: { branch: result.branch, commit: result.commit, committed: result.committed, files: result.files.length, ...(body.data.workflowIds?.length && { workflows: body.data.workflowIds }) } });
  return json(result);
});
