/**
 * "Listen for test event": POST `{ nodeId, workflow? }` makes the test URL of that Webhook or Form trigger
 * (/api/webhook-test/<path>, /form-test/<path>) answer for 120 s, running `workflow` (the editor's current state, saved
 * or not; default: the saved workflow) as a manual run. The response is an SSE stream: `listening` (path, the test
 * run's execution id, `expiresAt`), then the run's `execution` events and its `result`, as /run streams them; or
 * `timeout`, or `stopped` when the trigger started listening elsewhere. Closing the request stops listening and stops
 * a run that is still going. 409 while another workflow listens on the same test URL. See lib/server/test-webhooks.ts.
 */
import { z } from 'zod';
import type { Workflow } from '@landflow/engine';
import { currentActorId } from '@/lib/server/auth/context';
import { error, handler, parseBody } from '@/lib/server/http';
import { workflowSchema } from '@/lib/server/schemas';
import { store } from '@/lib/server/store';
import { listenerStream, startListening } from '@/lib/server/test-webhooks';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const listenSchema = z.object({
  nodeId: z.string().min(1),
  workflow: workflowSchema.optional(),
});

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const body = await parseBody(request, listenSchema);
  if (!body.ok) return body.response;
  const saved = store.getWorkflow(id);
  const workflow = (body.data.workflow ? { ...saved, ...body.data.workflow, id } : saved) as Workflow | undefined;
  if (!workflow) return error('Workflow not found', 404);
  const started = await startListening(workflow, body.data.nodeId, currentActorId());
  if (!started.ok) return error(started.error, started.status);
  return listenerStream(started.listener, request.signal);
});
