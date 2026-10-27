/**
 * Chat feedback on an agent session's replies (lib/server/chat-feedback.ts).
 *
 * GET /api/agents/:id/sessions/:sid/feedback → `{ feedback }`: the session's ratings, newest first
 * PUT /api/agents/:id/sessions/:sid/feedback `{ entryId, rating: 'up' | 'down' | null, comment? }` → `{ feedback }`;
 * `entryId` is the id of an assistant entry of the session's timeline, null takes the rating back
 */
import { z } from 'zod';
import { agentStore } from '@/lib/server/agents/store';
import { cleanComment, listAgentFeedback, setFeedback } from '@/lib/server/chat-feedback';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; sid: string }> };

const bodySchema = z.object({ entryId: z.string().min(1).max(200), rating: z.enum(['up', 'down']).nullable(), comment: z.string().max(2_000).optional() });

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id, sid } = await params;
  const session = agentStore.getSession(sid);
  if (!session || session.agentId !== id) return error('Session not found', 404);
  return json({ feedback: listAgentFeedback(id, sid) });
});

export const PUT = handler(async (request: Request, { params }: Ctx) => {
  const { id, sid } = await params;
  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  const session = agentStore.getSession(sid);
  if (!session || session.agentId !== id) return error('Session not found', 404);
  if (!session.timeline.some((entry) => entry.id === body.data.entryId && entry.type === 'assistant')) return error('That entry is not a reply of this session', 404);
  const feedback = setFeedback({ kind: 'agent', agentId: id, sessionId: sid, entryId: body.data.entryId }, body.data.rating, { comment: cleanComment(body.data.comment), source: 'api' });
  return json({ feedback: feedback ?? null });
});
