/**
 * POST /api/brain/ask `{ question, about? }` — ask the second brain (docs/second-brain.md#the-brain-page). It finds the
 * pages, facts and work the question is about, among what the caller can open, and the brain's model answers from them
 * with `[[type/id]]` page links and `[n]` work references. `about` (`<type>/<id>`) asks from a page. Without a model the
 * answer is left out and what was found comes back.
 */
import { z } from 'zod';
import { projectsOf, scopeForActor } from '@/lib/server/brain/scope';
import { vectorFactHits } from '@/lib/server/brain/study';
import { askBrain } from '@/lib/server/brain/wiki';
import { handler, json, parseBody } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

const Body = z.object({ question: z.string().trim().min(1).max(500), about: z.string().max(140).optional() });

export const POST = handler(async (request: Request) => {
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  const actor = routeActor();
  const scope = scopeForActor(actor);
  const vectorHits = await vectorFactHits(parsed.data.question, projectsOf(scope));
  return json(await askBrain(parsed.data.question, scope, actor, { vectorHits, ...(parsed.data.about && { about: parsed.data.about }), signal: request.signal }));
});
