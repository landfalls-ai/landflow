/**
 * POST /api/source-control/push — `{ message?, dryRun? }`: export the instance into the working copy, commit and
 * push the branch → `{ committed, commit, branch, files }`. A dry run reports what the commit would hold.
 */
import { z } from 'zod';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { pushToRepository, SourceControlError } from '@/lib/server/sync/git';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ message: z.string().max(5000).optional(), dryRun: z.boolean().default(false) });

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  try {
    return json(await pushToRepository(body.data));
  } catch (caught) {
    if (caught instanceof SourceControlError) return error(caught.message, caught.status);
    throw caught;
  }
});
