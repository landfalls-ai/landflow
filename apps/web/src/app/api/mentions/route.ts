import { z } from 'zod';
import { handler, json, parseQuery } from '@/lib/server/http';
import { searchMentions } from '@/lib/server/mentions/search';
import { routeActor } from '@/lib/server/projects/http';
import { MENTION_QUERY_MAX, MENTION_TYPES } from '@/lib/shared/mentions';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  q: z.string().max(MENTION_QUERY_MAX).optional(),
  // A comma list of kinds; an unknown one is a 400.
  types: z
    .string()
    .max(200)
    .optional()
    .transform((value) => (value ? value.split(',').map((t) => t.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.enum(MENTION_TYPES)).max(MENTION_TYPES.length).optional()),
  workflowId: z.string().min(1).max(200).optional(),
});

/**
 * GET /api/mentions?q=&types=&workflowId= — what the caller may tag with @, per kind (at most 8 each, a prefix match
 * first, then the newest): `{ groups: [{ type, items: [{ type, id, name, hint? }] }] }`. Only what the caller can open.
 */
export const GET = handler(async (request: Request) => {
  const query = parseQuery(request, querySchema);
  if (!query.ok) return query.response;
  const groups = await searchMentions(routeActor(), query.data);
  return json({ groups });
});
