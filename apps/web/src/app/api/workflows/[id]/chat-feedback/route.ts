/**
 * GET /api/workflows/:id/chat-feedback?rating=up|down&sessionId=&limit= — the thumbs up/down (and comments) the workflow's
 * hosted chat, widget and editor gave to its answers, newest first, with the totals (lib/server/chat-feedback.ts).
 */
import { isRating, listWorkflowFeedback } from '@/lib/server/chat-feedback';
import { error, handler, json } from '@/lib/server/http';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!store.getWorkflow(id)) return error('Workflow not found', 404);
  const query = new URL(request.url).searchParams;
  const rating = query.get('rating');
  if (rating && !isRating(rating)) return error("rating must be 'up' or 'down'", 400);
  const limit = Number(query.get('limit')) || 100;
  const sessionId = query.get('sessionId') ?? undefined;
  const feedback = listWorkflowFeedback(id, { ...(rating && isRating(rating) && { rating }), ...(sessionId && { sessionId }), limit });
  const all = listWorkflowFeedback(id, { limit: 500 });
  return json({ feedback, up: all.filter((f) => f.rating === 'up').length, down: all.filter((f) => f.rating === 'down').length });
});
