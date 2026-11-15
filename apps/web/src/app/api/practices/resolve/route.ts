import { z } from 'zod';
import { handler, json, error, parseQuery } from '@/lib/server/http';
import { resolvePractice, toFull } from '@/lib/server/practices/applicable';
import { routeActor } from '@/lib/server/projects/http';
import { PRACTICE_HANDLE, PRACTICE_LEVELS, PRACTICE_LIMITS, PRACTICE_REPO } from '@/lib/shared/practices';

export const dynamic = 'force-dynamic';

const many = <T extends z.ZodType>(item: T, max: number) =>
  z
    .union([item, z.array(item).max(max)])
    .optional()
    .transform((value) => (value === undefined ? undefined : Array.isArray(value) ? value : [value]));

const querySchema = z.object({
  handle: z.string().regex(PRACTICE_HANDLE),
  repo: z.string().regex(PRACTICE_REPO).optional(),
  path: many(z.string().min(1).max(500), PRACTICE_LIMITS.paths),
  projectId: z.string().min(1).max(200).optional(),
  level: z.enum(PRACTICE_LEVELS).optional(),
});

/**
 * GET /api/practices/resolve?handle=&repo=&path=&projectId=&level=: one approved practice in full (its rules and machine
 * checks): exactly the one `applicable` delivered for the same `repo`, `path`s and `projectId` (the same filter and ranking),
 * `level` keeping a winner of that level; 404 when delivery gave none, when practices are off, or for a project the caller
 * has no role in. Read from the approved version after the hash check, redacted.
 */
export const GET = handler(async (request: Request) => {
  const query = parseQuery(request, querySchema);
  if (!query.ok) return query.response;
  const { handle, repo, path, projectId, level } = query.data;
  // Like `applicable`: a project the caller has no role in is 404, and `projectId` narrows to that project and the organization's.
  const practice = resolvePractice({ actor: routeActor(), projectId }, handle, { repo, paths: path, level });
  return practice ? json({ practice: toFull(practice) }) : error(`No approved practice has the handle ${handle}`, 404);
});
