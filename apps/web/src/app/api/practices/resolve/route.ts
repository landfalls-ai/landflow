import { z } from 'zod';
import { handler, json, error, parseQuery } from '@/lib/server/http';
import { resolvePractice, toFull } from '@/lib/server/practices/applicable';
import { HttpError } from '@/lib/server/errors';
import { routeActor } from '@/lib/server/projects/http';
import { PRACTICE_HANDLE, PRACTICE_LEVELS, PRACTICE_REPO } from '@/lib/shared/practices';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  handle: z.string().regex(PRACTICE_HANDLE),
  repo: z.string().regex(PRACTICE_REPO).optional(),
  projectId: z.string().min(1).max(200).optional(),
  level: z.enum(PRACTICE_LEVELS).optional(),
});

/**
 * GET /api/practices/resolve?handle=&repo=&projectId=&level=: one approved practice in full (its rules and machine checks), the way
 * delivery and MCP `practice_get` pick it: the `projectId` match, else the selector's winner for `repo`, else the project
 * practice, then the organization's; `level` keeps one level. Only what delivery gives the caller: 404 when practices are off,
 * when none is approved, or when the caller may not get it. Read from the approved version after the hash check, redacted.
 */
export const GET = handler(async (request: Request) => {
  const query = parseQuery(request, querySchema);
  if (!query.ok) return query.response;
  const { handle, repo, projectId, level } = query.data;
  try {
    const practice = resolvePractice({ actor: routeActor() }, handle, { repo, projectId, level });
    return practice ? json({ practice: toFull(practice) }) : error(`No approved practice has the handle ${handle}`, 404);
  } catch (caught) {
    if (caught instanceof HttpError) return error(`No approved practice has the handle ${handle}`, 404);
    throw caught;
  }
});
