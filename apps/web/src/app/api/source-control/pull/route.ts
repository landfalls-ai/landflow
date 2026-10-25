/**
 * POST /api/source-control/pull — `{ dryRun?, prune?, force? }`: fetch the branch and apply its files (see
 * /api/sync/apply) → SyncApplyResult plus `{ commit, branch }`. Edits made on the instance since the last push or
 * pull are conflicts (409) unless `force`.
 */
import { z } from 'zod';
import { currentPrincipal } from '@/lib/server/auth';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { pullFromRepository, SourceControlError } from '@/lib/server/sync/git';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ dryRun: z.boolean().default(false), prune: z.boolean().default(false), force: z.boolean().default(false) });

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  try {
    const result = await pullFromRepository({ ...body.data, by: currentPrincipal()?.user.id });
    if (result.errors.length && !result.applied) return error(result.errors[0], 400, { ...result });
    if (result.conflicts && !result.applied && !result.dryRun) {
      return error(`${result.conflicts} change${result.conflicts === 1 ? '' : 's'} conflict with edits made on the instance since the last push or pull`, 409, { ...result });
    }
    return json(result);
  } catch (caught) {
    if (caught instanceof SourceControlError) return error(caught.message, caught.status);
    throw caught;
  }
});
