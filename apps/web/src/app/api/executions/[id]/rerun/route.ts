/**
 * Re-run an execution in the background: all of it with the same input, or
 * from one node (reusing everything before it), or just one node.
 */
import { z } from 'zod';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { planRerun, RerunError, startInBackground } from '@/lib/server/runner';
import { askMemberAgain } from '@/lib/server/agent-teams/ask-again';
import { store } from '@/lib/server/store';
import { traceparentHeader } from '@/lib/server/telemetry';
import { promoteExecution } from '@/lib/server/db/reads';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const rerunSchema = z.object({
  scope: z.enum(['all', 'from', 'only']).default('all'),
  nodeId: z.string().optional(),
  version: z.enum(['current', 'original']).default('current'),
  /** From a Run a Team node: the same message to the same member again (the lead is told to ask only that member). */
  askMember: z.object({ member: z.string().min(1), message: z.string().min(1).max(20_000) }).optional(),
});

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, rerunSchema);
  if (!body.ok) return body.response;
  try {
    // The re-run continues in the background inside this request's trace.
    const id = (await params).id;
    const { askMember, ...request } = body.data;
    if (askMember && (request.scope !== 'from' || !request.nodeId)) return error('askMember needs scope "from" and the Run a Team node as nodeId');
    const source = askMember ? await store.loadExecution(id) : undefined;
    if (askMember && !source) return error(`Execution ${id} not found`, 404);
    const workflow = askMember && source ? askMemberAgain(request.version === 'original' && source.workflow ? source.workflow : (store.getWorkflow(source.workflowId) ?? source.workflow), request.nodeId!, askMember) : undefined;
    await promoteExecution(id);
    const executionId = await startInBackground(planRerun(id, request, workflow));
    return json({ executionId }, { status: 202, headers: traceparentHeader() });
  } catch (caught) {
    if (caught instanceof RerunError) return error(caught.message, caught.status);
    throw caught;
  }
});
