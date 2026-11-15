/** The builder's "Test agent" chat: runs the draft and streams the session's timeline as SSE. */
import { z } from 'zod';
import { agentEventStream } from '@/lib/server/agents/http';
import { isRunning, newSession, runAgent } from '@/lib/server/agents/runtime';
import { agentStore } from '@/lib/server/agents/store';
import { currentActorId } from '@/lib/server/auth/context';
import { error, handler, parseBody } from '@/lib/server/http';
import { projectRole } from '@/lib/server/projects/access';
import { getProject } from '@/lib/server/projects/store';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const agent = agentStore.get((await params).id);
  if (!agent) return error('Agent not found', 404);
  const body = await parseBody(request, z.object({ message: z.string().trim().min(1).max(100_000), sessionId: z.string().optional(), projectId: z.string().max(200).optional() }));
  if (!body.ok) return body.response;
  // "Test in project": the block is that project's. A project the person has no role in is not found, not forbidden.
  const asked = body.data.projectId;
  if (asked && (!getProject(asked) || !projectRole(routeActor(), asked))) return error('Project not found', 404);
  let session = body.data.sessionId ? agentStore.getSession(body.data.sessionId) : undefined;
  if (body.data.sessionId && (!session || session.agentId !== agent.id)) return error('Session not found', 404);
  if (session && (isRunning(session.id) || session.status === 'running')) return error('This session is still answering — wait for the reply', 409);
  if (session?.status === 'awaiting_approval') return error('Approve or deny the pending tool calls first', 409);
  session ??= newSession(agent, { source: 'test', userId: 'you', version: 'draft' });
  const start = session;
  // A follow-up message stays in the project the test chat began in, unless it names another.
  const projectId = asked ?? (session.messages.length ? session.context?.projectId : undefined);
  // The person chatting: workflows the agent's tools run are theirs (agents/tools.ts, ToolCaller).
  const by = currentActorId();
  return agentEventStream((onEvent) => runAgent({ agent, session: start, message: body.data.message, onEvent, rootTrace: true, ...(projectId && { context: { caller: 'chat', agentId: agent.id, projectId } }), ...(by && { caller: { startedBy: by } }) }));
});
