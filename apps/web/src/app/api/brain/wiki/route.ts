/**
 * GET /api/brain/wiki — the Brain page's home (docs/second-brain.md#the-brain-page): the pages with how much work named
 * them lately, the customers and initiatives two or more teams worked on this week, each team's work, the open
 * suggestions, the latest work, what needs a person (no owner, quiet, summaries out of date) and the brain's status.
 * Only what the caller can open.
 */
import { scopeForActor } from '@/lib/server/brain/scope';
import { wikiHome } from '@/lib/server/brain/wiki';
import { handler, json } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const actor = routeActor();
  return json(wikiHome(scopeForActor(actor), actor));
});
