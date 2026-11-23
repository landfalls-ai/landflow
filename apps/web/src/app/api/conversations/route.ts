import { z } from 'zod';
import { createConversation, listConversations } from '@/lib/server/conversations/store';
import { handler, json, parseBody, parseQuery } from '@/lib/server/http';
import { decodeCursor, limitParam } from '@/lib/server/pagination';
import { getPreferences } from '@/lib/server/preferences';
import { routeActor } from '@/lib/server/projects/http';
import { CONVERSATION_SURFACES, createConversationSchema } from '@/lib/shared/conversations';

export const dynamic = 'force-dynamic';

const listQuery = z.object({
  surface: z.enum(CONVERSATION_SURFACES).optional(),
  subjectType: z.string().max(100).optional(),
  subjectId: z.string().max(200).optional(),
  q: z.string().max(200).optional(),
  limit: limitParam(100, 50),
  cursor: z
    .string()
    .max(512)
    .refine((text) => decodeCursor(text) !== undefined, 'Not a cursor from this API')
    .optional(),
});

/**
 * The signed-in person's own conversations (session only: policy.ts), newest first. Nobody else's are ever listed, admins
 * included. Nothing here is audited: a person's own chats are not a security-relevant change.
 */
export const GET = handler(async (request: Request) => {
  const query = parseQuery(request, listQuery);
  if (!query.ok) return query.response;
  return json(listConversations(routeActor().id, query.data));
});

/** POST { surface, subjectType?, subjectId?, projectId?, title? }: 201, or 200 `{ conversation: null, kept: false }` when the person keeps nothing. */
export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, createConversationSchema);
  if (!body.ok) return body.response;
  const actor = routeActor();
  if (!getPreferences(actor.id).keepConversations) return json({ conversation: null, kept: false });
  return json({ conversation: createConversation(actor.id, body.data) }, 201);
});
