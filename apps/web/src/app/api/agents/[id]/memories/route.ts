import { z } from 'zod';
import { agentStore } from '@/lib/server/agents/store';
import { embeddingsAnswer, listAgentMemories, memoryUsers } from '@/lib/server/agents/memory';
import { canResource, resourceAccess } from '@/lib/server/projects/access';
import { routeActor } from '@/lib/server/projects/http';
import { error, handler, json, parseQuery } from '@/lib/server/http';
import { decodeCursor, limitParam } from '@/lib/server/pagination';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const Query = z.object({
  /** Whose memories: a person's own by default; another person's only for the agent's editors. */
  user: z.string().trim().min(1).max(200).optional(),
  forgotten: z.enum(['0', '1']).optional(),
  limit: limitParam(100, 50),
  cursor: z
    .string()
    .max(512)
    .refine((text) => decodeCursor(text) !== undefined, 'Not a cursor from this API')
    .optional(),
});

/**
 * What an agent remembers about a person (docs/agents.md#memory), newest first, paged by `cursor`. Anyone who may read the agent
 * lists their own memories (`user` defaults to them); the agent's editors may name another person with `user`, and without it get
 * the people the agent has memories of (`users`). Another person's memories are "not found" to everyone else. `recall` says how
 * the next run finds the relevant ones: `meaning` (the embedding model answers) or `words`.
 */
export const GET = handler(async (request: Request, { params }: Ctx) => {
  const id = (await params).id;
  const actor = routeActor();
  if (!agentStore.get(id) || !resourceAccess(actor, 'agent', id)) return error('Agent not found', 404);
  const parsed = parseQuery(request, Query);
  if (!parsed.ok) return parsed.response;
  const { user, forgotten, limit, cursor } = parsed.data;
  const editor = canResource(actor, 'agent', id, 'update');
  if (user && user !== actor.id && !editor) return error('Agent not found', 404);
  const recall = (await embeddingsAnswer()) ? 'meaning' : 'words';
  if (!user && editor) return json({ items: [], users: memoryUsers(id, { limit: 100 }).users, recall });
  const page = listAgentMemories(id, user ?? actor.id, { limit, cursor, forgotten: forgotten === '1' });
  return json({ ...page, recall });
});
