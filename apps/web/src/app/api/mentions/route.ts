import { z } from 'zod';
import { currentPrincipal } from '@/lib/server/auth';
import { handler, json, parseQuery } from '@/lib/server/http';
import { searchMentions } from '@/lib/server/mentions/search';
import { routeActor } from '@/lib/server/projects/http';
import { keyMayTag } from '@/lib/server/mentions/key-scopes';
import { MENTION_QUERY_MAX, MENTION_TYPES, type MentionType } from '@/lib/shared/mentions';

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

/** The kinds an API key's scopes cover (a session may tag them all), so this route shows no more than the routes for each kind. */
function kindsFor(requested: readonly MentionType[] | undefined): MentionType[] {
  const keyScopes = currentPrincipal()?.apiKey?.scopes;
  const all = requested ?? MENTION_TYPES;
  return all.filter((t) => keyMayTag(keyScopes, t));
}

/**
 * GET /api/mentions?q=&types=&workflowId= — what the caller may tag with @, per kind (at most 8 each, a prefix match
 * first, then the newest): `{ groups: [{ type, items: [{ type, id, name, hint? }] }] }`. Only what the caller can open;
 * an API key also needs the scope of the kind's own routes (`MENTION_KEY_SCOPE` in lib/server/mentions/key-scopes.ts).
 */
export const GET = handler(async (request: Request) => {
  const query = parseQuery(request, querySchema);
  if (!query.ok) return query.response;
  const types = kindsFor(query.data.types);
  // An empty list would read as "every kind" downstream; a key that may tag none of what it asked for gets nothing.
  if (!types.length) return json({ groups: [] });
  const groups = await searchMentions(routeActor(), { ...query.data, types });
  return json({ groups });
});
