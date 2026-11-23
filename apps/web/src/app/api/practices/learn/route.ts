/**
 * POST /api/practices/learn `{ repo, sha, files: [{ path, content }], topics?, level?, projectId? }` — the brain's model reads
 * the files and drafts practices (docs/practices.md#learning). Every draft is tainted and none of its citations is
 * verified: the files came from the caller. 503 when the brain's model is off or practices are not loaded.
 */
import { brainModel } from '@/lib/server/brain/writer';
import { HttpError } from '@/lib/server/errors';
import { handler, json, parseBody } from '@/lib/server/http';
import { learnBodySchema, learnPractices } from '@/lib/server/practices/learn';
import { practicesPort } from '@/lib/server/practices/port';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

export const POST = handler(async (request: Request) => {
  const parsed = await parseBody(request, learnBodySchema);
  if (!parsed.ok) return parsed.response;
  const actor = routeActor();
  if (!practicesPort()) throw new HttpError('Practices are not loaded', 503, { expose: true });
  const model = brainModel();
  if (!model) throw new HttpError('The brain’s model is off', 503, { expose: true });
  return json(await learnPractices(parsed.data, { id: actor.id, role: actor.role }, model, request.signal));
});
