import { handler, json, parseBody } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';
import { runPlayground } from '@/lib/server/memory/playground';
import { playgroundSchema } from '@/lib/server/memory/playground-schema';
import { PLAYGROUND_LIMITS } from '@/lib/shared/memory-playground';
import { windowHit } from '@/lib/server/rate-limit/api-limiter';

export const dynamic = 'force-dynamic';

/**
 * POST { source: { kind: 'kb', agentId, toolId } | { kind: 'notebook', teamId } | { kind: 'facts', projectId? }, query, mode,
 * limit, threshold, rerank? }: one search that changes nothing (no note touched, no usage recorded) answered with the results'
 * scores before and after rerank, what the threshold dropped and the time per stage. A knowledge base needs edit access to its
 * agent, a notebook team access, facts project access; anything else is 404. 20 a minute a person (429 with Retry-After).
 */
export const POST = handler(async (request: Request) => {
  const actor = routeActor();
  const body = await parseBody(request, playgroundSchema);
  if (!body.ok) return body.response;
  const limited = await windowHit(`memory-playground:${actor.id}`, PLAYGROUND_LIMITS.perMinute, 60_000);
  if (!limited.allowed) return Response.json({ error: 'Too many searches: wait a moment', code: 'rate_limited', retryAfter: limited.retryAfter }, { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } });
  return json(await runPlayground(actor, body.data));
});
