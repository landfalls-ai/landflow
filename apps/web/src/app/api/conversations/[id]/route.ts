import { deleteConversation, getConversation, listItems, updateConversation } from '@/lib/server/conversations/store';
import { sanitizeItems } from '@/lib/server/conversations/sanitize';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';
import { updateConversationSchema } from '@/lib/shared/conversations';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const NOT_FOUND = () => error('Conversation not found', 404);

/** One of the person's conversations with its items. Someone else's id (an admin's too) answers 404. */
export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const actor = routeActor();
  const conversation = getConversation(actor.id, (await params).id);
  if (!conversation) return NOT_FOUND();
  return json({ conversation, items: await sanitizeItems(actor, conversation, listItems(actor.id, conversation.id)) });
});

/** PATCH { title?, pinned? } */
export const PATCH = handler(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, updateConversationSchema);
  if (!body.ok) return body.response;
  const conversation = updateConversation(routeActor().id, (await params).id, body.data);
  return conversation ? json({ conversation }) : NOT_FOUND();
});

/** Deletes the conversation and its items for good. */
export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  if (!deleteConversation(routeActor().id, (await params).id)) return NOT_FOUND();
  return new Response(null, { status: 204 });
});
