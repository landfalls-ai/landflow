/** The builder's "Test agent" chat: runs the draft and streams the session's timeline as SSE. */
import { z } from 'zod';
import { agentEventStream } from '@/lib/server/agents/http';
import { isRunning, newSession, runAgent } from '@/lib/server/agents/runtime';
import { agentStore } from '@/lib/server/agents/store';
import { error, handler, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const agent = agentStore.get((await params).id);
  if (!agent) return error('Agent not found', 404);
  const body = await parseBody(request, z.object({ message: z.string().trim().min(1).max(100_000), sessionId: z.string().optional() }));
  if (!body.ok) return body.response;
  let session = body.data.sessionId ? agentStore.getSession(body.data.sessionId) : undefined;
  if (body.data.sessionId && (!session || session.agentId !== agent.id)) return error('Session not found', 404);
  if (session && (isRunning(session.id) || session.status === 'running')) return error('This session is still answering — wait for the reply', 409);
  if (session?.status === 'awaiting_approval') return error('Approve or deny the pending tool calls first', 409);
  session ??= newSession(agent, { source: 'test', userId: 'you', version: 'draft' });
  const start = session;
  return agentEventStream((onEvent) => runAgent({ agent, session: start, message: body.data.message, onEvent, rootTrace: true }));
});
