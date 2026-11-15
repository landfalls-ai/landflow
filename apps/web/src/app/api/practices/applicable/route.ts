import { z } from 'zod';
import { handler, json, parseQuery } from '@/lib/server/http';
import { applicableFor, PRACTICE_SIZES } from '@/lib/server/practices/applicable';
import { routeActor } from '@/lib/server/projects/http';
import { PRACTICE_LIMITS, PRACTICE_REPO, PRACTICE_TOPIC } from '@/lib/shared/practices';

export const dynamic = 'force-dynamic';

const many = <T extends z.ZodType>(item: T, max: number) =>
  z
    .union([item, z.array(item).max(max)])
    .optional()
    .transform((value) => (value === undefined ? undefined : Array.isArray(value) ? value : [value]));

const querySchema = z.object({
  repo: z.string().regex(PRACTICE_REPO).optional(),
  path: many(z.string().min(1).max(500), PRACTICE_LIMITS.paths),
  topic: many(z.string().regex(PRACTICE_TOPIC), 5),
  projectId: z.string().min(1).max(200).optional(),
  task: z.string().max(500).optional(),
  size: z.enum(PRACTICE_SIZES).default('mod'),
  preview: z.enum(['1', '0']).optional(),
});

/**
 * GET /api/practices/applicable?repo=&path=&topic=&projectId=&task=&size=full|mod|index&preview=1: the approved practices that
 * apply for the caller, as a block that fits the size (`ApplicableResponse`). Org practices, and project practices of the
 * projects the caller is in; what is sent only narrows and ranks. Records `delivered` rows unless `preview=1`.
 */
export const GET = handler(async (request: Request) => {
  const query = parseQuery(request, querySchema);
  if (!query.ok) return query.response;
  const { repo, path, topic, projectId, task, size, preview } = query.data;
  const actor = routeActor();
  const { included: _included, ...answer } = applicableFor({ actor, projectId }, { repo, paths: path, topics: topic, task }, { size, preview: preview === '1' });
  return json(answer);
});
