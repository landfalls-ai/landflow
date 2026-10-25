/**
 * POST /api/environment/promote — `{ target, source?, workflows?, prune?, dryRun?, force?, message? }`: copy this
 * environment's branch (all workflows, or the ones named by id or name) onto the target environment's branch, which
 * then pulls it. → PromotionResult with a diff per workflow. Conflicts (the target changed a workflow since the last
 * promotion) stop it with 409 unless `force`; a dry run only previews.
 */
import { z } from 'zod';
import { currentPrincipal } from '@/lib/server/auth';
import { EnvironmentError, promoteEnvironment } from '@/lib/server/environments';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { SourceControlError } from '@/lib/server/sync/git';

export const dynamic = 'force-dynamic';

const bodySchema = z.strictObject({
  target: z.string().min(1).max(40),
  source: z.string().min(1).max(40).optional(),
  workflows: z.array(z.string().min(1).max(200)).max(1000).optional(),
  prune: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  force: z.boolean().default(false),
  message: z.string().max(2000).optional(),
});

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  try {
    const result = await promoteEnvironment({ ...body.data, by: currentPrincipal()?.user.name });
    if (result.conflicts && !result.promoted && !result.dryRun) {
      return error(`${result.conflicts} workflow${result.conflicts === 1 ? '' : 's'} changed on ${result.to.branch} since the last promotion from ${result.from.environment}: review the diff, then promote with force`, 409, { ...result });
    }
    return json(result);
  } catch (caught) {
    if (caught instanceof EnvironmentError || caught instanceof SourceControlError) return error(caught.message, caught.status);
    throw caught;
  }
});
