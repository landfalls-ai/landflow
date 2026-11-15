import { z } from 'zod';
import { handler, json, error, parseQuery } from '@/lib/server/http';
import { resolvePractice, resolvePracticeById, toFull } from '@/lib/server/practices/applicable';
import { routeActor } from '@/lib/server/projects/http';
import { PRACTICE_HANDLE, PRACTICE_LEVELS, PRACTICE_LIMITS, PRACTICE_REPO, PRACTICE_TOPIC } from '@/lib/shared/practices';

export const dynamic = 'force-dynamic';

const many = <T extends z.ZodType>(item: T, max: number) =>
  z
    .union([item, z.array(item).max(max)])
    .optional()
    .transform((value) => (value === undefined ? undefined : Array.isArray(value) ? value : [value]));

const querySchema = z
  .object({
    handle: z.string().regex(PRACTICE_HANDLE).optional(),
    id: z.string().regex(/^prc_[A-Za-z0-9_-]{1,100}$/).optional(),
    repo: z.string().regex(PRACTICE_REPO).optional(),
    path: many(z.string().min(1).max(500), PRACTICE_LIMITS.paths),
    topic: many(z.string().regex(PRACTICE_TOPIC), 5),
    projectId: z.string().min(1).max(200).optional(),
    level: z.enum(PRACTICE_LEVELS).optional(),
  })
  .refine((q) => (q.handle === undefined) !== (q.id === undefined), { message: 'Give either handle or id, not both and not neither' });

/**
 * GET /api/practices/resolve?handle= (or id=prc_…, which must be in the listing's delivery for the same scope)&repo=&path=&topic=&projectId=&level=: one approved practice in full (its rules and machine
 * checks): exactly the one `applicable` delivered for the same `repo`, `path`s, `topic`s and `projectId` (the same filter and ranking),
 * `level` keeping a winner of that level; 404 when delivery gave none, when practices are off, or for a project the caller
 * has no role in. Read from the approved version after the hash check, redacted.
 */
export const GET = handler(async (request: Request) => {
  const query = parseQuery(request, querySchema);
  if (!query.ok) return query.response;
  const { handle, id, repo, path, topic, projectId, level } = query.data;
  // Like `applicable`: a project the caller has no role in is 404, and `projectId` narrows to that project and the organization's.
  if (id !== undefined) {
    const byId = resolvePracticeById({ actor: routeActor(), projectId }, id, { repo, paths: path, topics: topic, level });
    return byId ? json({ practice: toFull(byId) }) : error(`No approved practice has the id ${id}`, 404);
  }
  const practice = resolvePractice({ actor: routeActor(), projectId }, handle as string, { repo, paths: path, topics: topic, level });
  return practice ? json({ practice: toFull(practice) }) : error(`No approved practice has the handle ${handle}`, 404);
});
