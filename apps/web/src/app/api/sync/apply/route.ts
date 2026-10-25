/**
 * POST /api/sync/apply — make the instance match a set of Git sync files: `{ files: [{ path, content }], prune?,
 * dryRun?, force?, base? }` → SyncApplyResult. Creates and updates by stable id; deletes only with `prune`. `base`
 * (the hashes of the last pull) turns changes made on the instance since then into conflicts, which stop the apply
 * (409) unless `force`. Files that don't read or validate answer 400 and nothing is applied. A dry run plans only.
 */
import { z } from 'zod';
import { currentPrincipal } from '@/lib/server/auth';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { applySync } from '@/lib/server/sync';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  files: z.array(z.object({ path: z.string().min(1).max(1000), content: z.string().max(20_000_000) })).max(20_000),
  prune: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  force: z.boolean().default(false),
  base: z.record(z.string(), z.string()).optional(),
});

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  const { files, ...options } = body.data;
  const result = await applySync(files, { ...options, by: currentPrincipal()?.user.id, note: 'Git sync (CLI)' });
  if (result.errors.length && !result.applied) return error(result.errors[0], 400, { ...result });
  if (result.conflicts && !result.applied && !result.dryRun) {
    return error(`${result.conflicts} change${result.conflicts === 1 ? '' : 's'} conflict with edits made on the instance since the last sync`, 409, { ...result });
  }
  return json(result);
});
