/**
 * POST /request-access/api/chat `{ message, sessionId }` → `{ reply, requestId? }`: one message to the access chat, run as the signed-in outside
 * requester. The assistant can only file a request, after the person confirmed it in a later message; it never approves or grants. Every message
 * can start a model call, so there are three limits: 10 a minute and 100 a day per requester, and an instance-wide hourly cap for all outsiders
 * (`LANDFLOW_ACCESS_OUTSIDE_CHAT_PER_HOUR`, default 600, 0 turns the outside chat off). Over one: 429 with Retry-After. A message is at most 2,000
 * characters (400). 409 when the chat is off or not set up.
 */
import { z } from 'zod';
import { outsideChatPerHour, runAccessChat } from '@/lib/server/access/chat';
import { takeOutsideShared } from '@/lib/server/access/outside/limits';
import { outsideRoute, tooMany } from '@/lib/server/access/outside/http';
import { json, parseBody } from '@/lib/server/http';
import { OUTSIDE_LIMITS } from '@/lib/shared/access';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ message: z.string().min(1).max(OUTSIDE_LIMITS.chatChars), sessionId: z.string().min(1).max(100) });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const busy = tooMany;

export const POST = outsideRoute(
  async ({ req, requester }) => {
    const body = await parseBody(req, bodySchema);
    if (!body.ok) return body.response;
    const cap = outsideChatPerHour();
    if (cap <= 0) return Response.json({ error: 'The chat is not available here; use the form' }, { status: 409 });
    // The requester's own limits first, so a person over theirs never uses up the instance's.
    if (!(await takeOutsideShared('access-chat-minute', requester.id, OUTSIDE_LIMITS.chatPerMinute, MINUTE))) return busy('Too many messages: wait a moment', 60);
    if (!(await takeOutsideShared('access-chat-day', requester.id, OUTSIDE_LIMITS.chatPerDay, DAY))) return busy('You have used today’s messages; use the form or come back tomorrow', 3_600);
    if (!(await takeOutsideShared('access-chat-all', 'instance', cap, HOUR))) return busy('The chat is busy; use the form', 300);
    return json(await runAccessChat(requester, body.data));
  },
  { write: true },
);
