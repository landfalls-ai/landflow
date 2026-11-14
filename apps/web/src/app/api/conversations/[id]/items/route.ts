import { appendItems, getConversation } from '@/lib/server/conversations/store';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { getPreferences } from '@/lib/server/preferences';
import { routeActor } from '@/lib/server/projects/http';
import { appendItemsSchema } from '@/lib/shared/conversations';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** POST { items: [{ role, parts, meta? }] } (1 to 20, each up to 32 KB) → `{ seq }`; 204 with nothing stored when the person keeps nothing. */
export const POST = handler(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, appendItemsSchema);
  if (!body.ok) return body.response;
  const actor = routeActor();
  const id = (await params).id;
  if (!getConversation(actor.id, id)) return error('Conversation not found', 404);
  if (!getPreferences(actor.id).keepConversations) return new Response(null, { status: 204 });
  const seq = appendItems(actor.id, id, body.data.items);
  return seq === undefined ? error('Conversation not found', 404) : json({ seq });
});
