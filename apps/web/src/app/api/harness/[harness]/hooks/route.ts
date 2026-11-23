import { z } from 'zod';
import { currentPrincipal } from '@/lib/server/auth/guard';
import { error, handler, parseBody } from '@/lib/server/http';
import { ingestHookEvent } from '@/lib/server/harness/ingest';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

/** The largest hook event taken (C04 FR-1). */
const MAX_EVENT_BYTES = 64 * 1024;

/**
 * POST /api/harness/:harness/hooks: one hook event of a coding harness (docs/harnesses.md#live-status). Claude Code's hook JSON as
 * sent, authenticated by an API key with the `harness:write` scope (a cookie session or an MCP token is refused). Binds the event to a session of the
 * key's owner, applies it to the status machine and answers 204 with no body, so a hook never waits long. 404 for a harness
 * that sends no events, 400 for a payload without `hook_event_name` and `session_id`, 413 over 64 KB, 429 with `retryAfter`
 * over the per-key limits. Not in the audit log per call; a refused key is (api.denied, once a minute).
 */
export const POST = handler(async (request: Request, { params }: { params: Promise<{ harness: string }> }) => {
  const { harness } = await params;
  const principal = currentPrincipal();
  if (principal && principal.via !== 'api-key' && principal.via !== 'test') return error('Send an API key with the harness:write scope', 403);
  const actor = routeActor();
  const body = await parseBody(request, z.record(z.string(), z.unknown()), { maxBytes: MAX_EVENT_BYTES });
  if (!body.ok) return body.response;
  const result = await ingestHookEvent({ harness, actor, keyId: principal?.apiKey?.id ?? `user:${actor.id}`, payload: body.data, headers: request.headers });
  if (result.status === 429) return error('Too many hook events', 429, { retryAfter: result.retryAfter });
  if (result.status === 404) return error('Not found', 404);
  return new Response(null, { status: 204 });
});
