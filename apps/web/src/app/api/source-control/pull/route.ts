/**
 * POST /api/source-control/pull — `{ dryRun?, prune?, force? }`: fetch the branch and apply its files (see
 * /api/sync/apply) → SyncApplyResult plus `{ commit, branch }`. Edits made on the instance since the last push or
 * pull are conflicts (409) unless `force`.
 */
import { z } from 'zod';
import { currentPrincipal } from '@/lib/server/auth';
import { defaultPublishMode } from '@/lib/server/environments/settings';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { pullFromRepository } from '@/lib/server/sync/git';
import { recordAudit } from '@/lib/server/audit';

export const dynamic = 'force-dynamic';

// `publish` (file, all or none; additive): what the pull does with publication, defaulting to Settings → Environments' choice.
const bodySchema = z.object({ dryRun: z.boolean().default(false), prune: z.boolean().default(false), force: z.boolean().default(false), publish: z.enum(['file', 'all', 'none']).optional(), updateCredentials: z.boolean().optional() });

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  const result = await pullFromRepository({ ...body.data, publish: body.data.publish ?? defaultPublishMode(), by: currentPrincipal()?.user.id });
  if (!result.dryRun) {
    recordAudit({
      action: 'source_control.pull',
      outcome: result.applied ? 'success' : 'failure',
      target: { type: 'repository', name: result.branch },
      summary: result.applied ? `Pulled ${result.appliedCount} change${result.appliedCount === 1 ? '' : 's'} from ${result.branch}` : `Pull from ${result.branch} not applied`,
      details: { branch: result.branch, commit: result.commit, applied: result.appliedCount, conflicts: result.conflicts, errors: result.errors.length, prune: body.data.prune, force: body.data.force },
    });
  }
  if (result.errors.length && !result.applied) return error(result.errors[0], 400, { ...result });
  if (result.conflicts && !result.applied && !result.dryRun) {
    return error(`${result.conflicts} change${result.conflicts === 1 ? '' : 's'} conflict with edits made on the instance since the last push or pull`, 409, { ...result });
  }
  return json(result);
});
