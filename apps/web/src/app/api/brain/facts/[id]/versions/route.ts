/**
 * GET /api/brain/facts/:id/versions?limit=&cursor= — a fact's chain of versions, oldest first (docs/second-brain.md#fact-versions).
 * `:id` is the chain id (or one version's `<chain id>#v<n>`), URL-encoded: entity fact ids hold `/`. At most 100 a page;
 * `nextCursor` (the last version of the page) opens the next. Anyone who may read the fact's subject; others get 404.
 */
import { z } from 'zod';
import { FactNotFoundError, factVersions, getFact } from '@/lib/server/brain/facts';
import { canFact } from '@/lib/server/brain/scope';
import { factFor } from '@/lib/server/brain/fact-lifecycle';
import { handler, json, parseQuery } from '@/lib/server/http';
import { limitParam } from '@/lib/server/pagination';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

const Query = z.object({ limit: limitParam(100, 100), cursor: z.coerce.number().int().min(0).optional() });

export const GET = handler(async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
  const query = parseQuery(request, Query);
  if (!query.ok) return query.response;
  const id = decodeURIComponent((await ctx.params).id);
  const actor = routeActor();
  const asked = factFor(actor, id, 'read');
  // A forgotten chain is for the people who may restore it; to anyone else it is gone, and a reason never goes to a reader.
  const latest = getFact(asked.rootId ?? id, undefined, { includeForgotten: true }) ?? asked;
  const editor = canFact(actor, latest, 'update');
  if ((latest.forgottenAt || asked.forgottenAt) && !editor) throw new FactNotFoundError();
  const page = factVersions(id, { limit: query.data.limit, after: query.data.cursor, withForget: editor });
  return json({ versions: page.versions, ...(page.next !== undefined && { nextCursor: String(page.next) }) });
});
