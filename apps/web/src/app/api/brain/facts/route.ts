/**
 * GET /api/brain/facts — what the second brain has learned: `?q=` searches (keywords fused with the vector index when
 * there is one), else `?subjectType=&subjectId=&kind=&status=active|stale|all&limit=` lists. Members see facts about the
 * workflows and agents they can open; facts about node types, credentials and the instance are for owners and admins.
 * Only the latest version of a fact comes back, and never a forgotten one; `?history=1` adds earlier versions and
 * `?forgotten=1` lists the forgotten facts the caller may restore (docs/second-brain.md#fact-versions).
 */
import { z } from 'zod';
import { FACT_KINDS, FACT_SUBJECTS, type FactKind, type FactSubject } from '@/lib/shared/brain';
import { listFacts, searchFacts } from '@/lib/server/brain/facts';
import { canFact, projectsOf, scopeForActor } from '@/lib/server/brain/scope';
import { vectorFactHits } from '@/lib/server/brain/study';
import { handler, json, parseQuery } from '@/lib/server/http';
import { limitParam } from '@/lib/server/pagination';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

const Query = z.object({ limit: limitParam(500, 100), history: z.enum(['1', 'true']).optional(), forgotten: z.enum(['1', 'true']).optional() }).passthrough();

export const GET = handler(async (request: Request) => {
  const query = parseQuery(request, Query);
  if (!query.ok) return query.response;
  const url = new URL(request.url);
  const param = (name: string) => url.searchParams.get(name)?.trim() || undefined;
  const actor = routeActor();
  const scope = scopeForActor(actor);
  const { limit, history, forgotten } = query.data;
  const subjectType = (FACT_SUBJECTS as readonly string[]).includes(param('subjectType') ?? '') ? (param('subjectType') as FactSubject) : undefined;
  const kind = (FACT_KINDS as readonly string[]).includes(param('kind') ?? '') ? (param('kind') as FactKind) : undefined;
  const q = param('q');
  if (q) {
    const vectorHits = await vectorFactHits(q, projectsOf(scope));
    const facts = searchFacts(q, { scope, limit: 500, vectorHits }).filter((f) => (!subjectType || f.subjectType === subjectType) && (!kind || f.kind === kind));
    return json({ facts: facts.slice(0, limit) });
  }
  if (forgotten) {
    // Forgotten facts are for the people who may restore them.
    const facts = listFacts({ subjectType, subjectId: param('subjectId'), kind, status: 'all', scope, limit: 5_000, forgotten: 'only' }).filter((f) => canFact(actor, f, 'update'));
    return json({ facts: facts.slice(0, limit) });
  }
  const requested = param('status');
  const status = requested === 'stale' || requested === 'all' ? requested : 'active';
  return json({ facts: listFacts({ subjectType, subjectId: param('subjectId'), kind, status, scope, limit, history: Boolean(history) }) });
});
