/**
 * POST /api/access/chat `{ message, sessionId }` → `{ reply, requestId? }`: one message to the access chat, run as the signed-in user. The
 * assistant can only file a request, after the person confirmed it in a later message; it never approves or grants. 409 when the chat is not set up. Every message can start a model call, so a person gets 20 a minute (429 with Retry-After).
 */
import { z } from 'zod';
import { runAccessChat } from '@/lib/server/access/chat';
import { handler, json, parseBody } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';
import { windowHit } from '@/lib/server/rate-limit/api-limiter';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ message: z.string().min(1).max(4000), sessionId: z.string().min(1).max(100) });

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  const actor = routeActor();
  const limited = await windowHit(`access-chat:${actor.id}`, 20, 60_000);
  if (!limited.allowed) return Response.json({ error: 'Too many messages: wait a moment', code: 'rate_limited', retryAfter: limited.retryAfter }, { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } });
  return json(await runAccessChat(actor, body.data));
});
