/**
 * GET /api/ai-calls/:id: one model call's view (docs/run-trace.md#spend): the call, its prompt split in tokens (never text),
 * what changed against the call before it, and a link to its run. Who may open it is docs/llm-gateway.md "Who sees
 * what" (rule 3); a call the caller can't open answers 404.
 */
import { aiCallView } from '@/lib/server/ai-usage/run-spend';
import { error, handler, json } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  const view = aiCallView(id, routeActor());
  return view ? json(view) : error('Call not found', 404);
});
