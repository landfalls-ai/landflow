/**
 * GET /api/brain/facts — what the second brain has learned: `?q=` searches (keywords fused with the vector index when
 * there is one), else `?subjectType=&subjectId=&kind=&status=active|stale|all&limit=` lists. Members see facts about the
 * workflows and agents they can open; facts about node types, credentials and the instance are for owners and admins.
 */
import { FACT_KINDS, FACT_SUBJECTS, type FactKind, type FactSubject } from '@/lib/shared/brain';
import { listFacts, searchFacts } from '@/lib/server/brain/facts';
import { projectsOf, scopeForActor } from '@/lib/server/brain/scope';
import { vectorFactHits } from '@/lib/server/brain/study';
import { handler, json } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => {
  const url = new URL(request.url);
  const param = (name: string) => url.searchParams.get(name)?.trim() || undefined;
  const scope = scopeForActor(routeActor());
  const limit = Math.min(Number(param('limit') ?? 100) || 100, 500);
  const subjectType = (FACT_SUBJECTS as readonly string[]).includes(param('subjectType') ?? '') ? (param('subjectType') as FactSubject) : undefined;
  const kind = (FACT_KINDS as readonly string[]).includes(param('kind') ?? '') ? (param('kind') as FactKind) : undefined;
  const q = param('q');
  if (q) {
    const vectorHits = await vectorFactHits(q, projectsOf(scope));
    const facts = searchFacts(q, { scope, limit: 500, vectorHits }).filter((f) => (!subjectType || f.subjectType === subjectType) && (!kind || f.kind === kind));
    return json({ facts: facts.slice(0, limit) });
  }
  const requested = param('status');
  const status = requested === 'stale' || requested === 'all' ? requested : 'active';
  return json({ facts: listFacts({ subjectType, subjectId: param('subjectId'), kind, status, scope, limit }) });
});
