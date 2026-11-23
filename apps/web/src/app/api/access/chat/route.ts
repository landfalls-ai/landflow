/**
 * POST /api/access/chat `{ message, sessionId }` → `{ reply, requestId? }`: one message to the access chat, run as the signed-in user. The
 * assistant can only file a request, after the person confirmed it in a later message; it never approves or grants. 409 when the chat is not set up.
 */
import { z } from 'zod';
import { runAccessChat } from '@/lib/server/access/chat';
import { handler, json, parseBody } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ message: z.string().min(1).max(4000), sessionId: z.string().min(1).max(100) });

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  return json(await runAccessChat(routeActor(), body.data));
});
