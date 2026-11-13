/** Approve or deny a paused tool call; once every call of the turn is decided the run continues (SSE). */
import { z } from 'zod';
import { recordAudit } from '@/lib/server/audit';
import { agentEventStream } from '@/lib/server/agents/http';
import { decide } from '@/lib/server/agents/runtime';
import { agentStore } from '@/lib/server/agents/store';
import { error, handler, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; sid: string }> };

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id, sid } = await params;
  const agent = agentStore.get(id);
  if (!agent) return error('Agent not found', 404);
  const body = await parseBody(request, z.object({ callId: z.string(), approved: z.boolean() }));
  if (!body.ok) return body.response;
  const session = agentStore.getSession(sid);
  if (!session || session.agentId !== id) return error('Session not found', 404);
  const call = session.pending?.calls.find((c) => c.callId === body.data.callId);
  if (!call) return error('That tool call is not waiting for approval', 409);
  if (call.decision) return error(`Already ${call.decision}`, 409);
  recordAudit({
    action: 'agent.tool_approval',
    target: { type: 'agent', id, name: agent.name },
    summary: `${body.data.approved ? 'Approved' : 'Denied'} ${agent.name}’s call to ${call.tool}`,
    details: { decision: body.data.approved ? 'approved' : 'denied', tool: call.tool, sessionId: sid, callId: body.data.callId },
  });
  return agentEventStream((onEvent) => decide(agent, sid, body.data.callId, body.data.approved, { onEvent }));
});
