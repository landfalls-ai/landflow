import { z } from 'zod';
import { handler, json, parseBody } from '@/lib/server/http';
import { recordCitations } from '@/lib/server/practices/cite';
import { routeActor } from '@/lib/server/projects/http';
import { PRACTICE_LIMITS, PRACTICE_REPO } from '@/lib/shared/practices';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  text: z.string().max(20_000).optional(),
  citations: z.array(z.string().max(120)).max(PRACTICE_LIMITS.citations).optional(),
  executionId: z.string().min(1).max(200).optional(),
  repo: z.string().regex(PRACTICE_REPO).optional(),
});

/**
 * POST /api/practices/cite { text?, citations?, executionId?, repo? }: records `cited` rows for the practice versions an answer
 * or a commit names (the "Practices followed: [handle@version]" line, `Practice: handle@version` lines, or `citations`), for
 * the practices the caller may get. `{ recorded, unknown }`.
 */
export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  return json(recordCitations({ actor: routeActor() }, body.data));
});
