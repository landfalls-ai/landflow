/**
 * Chat feedback on one execution's answer (lib/server/chat-feedback.ts), the same rating the hosted chat and widget give.
 *
 * GET /api/executions/:id/feedback → `{ feedback }` (null when unrated)
 * PUT /api/executions/:id/feedback `{ rating: 'up' | 'down' | null, comment? }` → `{ feedback }`; null takes the rating back
 */
import { z } from 'zod';
import { cleanComment, executionFeedback, setFeedback } from '@/lib/server/chat-feedback';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({ rating: z.enum(['up', 'down']).nullable(), comment: z.string().max(2_000).optional() });

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!(await store.loadExecution(id))) return error('Execution not found', 404);
  return json({ feedback: executionFeedback(id) ?? null });
});

export const PUT = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  const record = await store.loadExecution(id);
  if (!record) return error('Execution not found', 404);
  const earlier = executionFeedback(id);
  const feedback = setFeedback({ kind: 'execution', workflowId: record.workflowId, executionId: id, ...(earlier?.sessionId && { sessionId: earlier.sessionId }) }, body.data.rating, {
    comment: cleanComment(body.data.comment),
    source: 'api',
  });
  return json({ feedback: feedback ?? null });
});
