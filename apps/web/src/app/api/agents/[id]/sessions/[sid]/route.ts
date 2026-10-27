import { isRunning } from '@/lib/server/agents/runtime';
import { agentStore } from '@/lib/server/agents/store';
import { listAgentFeedback } from '@/lib/server/chat-feedback';
import { error, handler, json } from '@/lib/server/http';
import { traceUrl } from '@/lib/server/telemetry';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; sid: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id, sid } = await params;
  const session = agentStore.getSession(sid);
  if (!session || session.agentId !== id) return error('Session not found', 404);
  // Links to the trace UI when LANDFLOW_TRACE_URL is set.
  const traceUrls = Object.fromEntries(
    session.traceIds.flatMap((traceId) => {
      const link = traceUrl(traceId);
      return link ? [[traceId, link]] : [];
    }),
  );
  return json({ session, traceUrls, feedback: listAgentFeedback(id, sid) });
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  const { id, sid } = await params;
  if (isRunning(sid)) return error('The session is still running', 409);
  return agentStore.deleteSession(id, sid) ? json({ ok: true }) : error('Session not found', 404);
});
