/**
 * POST /api/environment/pull — `{ dryRun?, prune?, force?, publish? }`: pull this environment's branch (Settings →
 * Source control) and apply it, like /api/source-control/pull. `publish` (file, all or none) defaults to the
 * environment's publish-on-pull setting. Promoted credentials map by name or by Settings → Environments' mappings.
 */
import { z } from 'zod';
import { currentPrincipal } from '@/lib/server/auth';
import { PUBLISH_MODES, pullEnvironment } from '@/lib/server/environments';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { SourceControlError } from '@/lib/server/sync/git';

export const dynamic = 'force-dynamic';

const bodySchema = z.strictObject({ dryRun: z.boolean().default(false), prune: z.boolean().default(false), force: z.boolean().default(false), publish: z.enum(PUBLISH_MODES).optional() });

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  try {
    const result = await pullEnvironment({ ...body.data, by: currentPrincipal()?.user.id });
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
