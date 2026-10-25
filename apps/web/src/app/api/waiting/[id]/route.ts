/**
 * Resume URL of a Wait node set to "On Webhook Call": any method on
 * /api/waiting/<executionId> continues the waiting execution, with the request
 * (`{ method, path, headers, query, body }`) as the Wait node's output. The Wait
 * node's Respond setting picks the answer, as for the Webhook trigger.
 */
import type { NodeItem } from '@landflow/protocol';
import { BinaryTooLargeError } from '@/lib/server/binary/store';
import { error, handler } from '@/lib/server/http';
import { liveExecution, resumeExecution, ResumeError, type RunReply } from '@/lib/server/runner';
import { store } from '@/lib/server/store';
import { logger, recordWebhookRequest } from '@/lib/server/telemetry';
import { answerWebhook, deferred, requestItem, type RespondMode } from '@/lib/server/webhooks';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

async function handle(request: Request, { params }: Ctx) {
  const { id } = await params;
  const method = request.method.toUpperCase();
  const record = liveExecution(id) ? undefined : store.getExecution(id);
  const wait = record?.status === 'waiting' ? record.wait : undefined;
  if (!record || !wait) {
    recordWebhookRequest(404);
    return error(liveExecution(id) ? 'This execution is running, not waiting' : 'No execution is waiting here', liveExecution(id) ? 409 : 404);
  }
  if (wait.resume !== 'webhook') {
    recordWebhookRequest(409, record.workflowId);
    return error(wait.resume === 'form' ? `This execution waits for a form submission at /form/waiting/${id}` : 'This execution does not wait for a webhook call', 409);
  }
  if (wait.method && wait.method !== method) {
    recordWebhookRequest(405, record.workflowId);
    return error(`This execution waits for a ${wait.method} request`, 405, { allow: wait.method });
  }

  // Uploaded files go straight into the waiting execution's scope.
  let item: NodeItem;
  try {
    item = await requestItem(request, `waiting/${id}`, { executionId: id });
  } catch (caught) {
    if (caught instanceof BinaryTooLargeError) {
      recordWebhookRequest(413, record.workflowId);
      return error(caught.message, 413);
    }
    throw caught;
  }
  const mode = (['immediately', 'lastNode', 'responseNode'].includes(String(wait.data?.respond)) ? wait.data?.respond : 'immediately') as RespondMode;
  const reply = deferred<RunReply>();
  // The resumed part of the run is a child of this request's span (resumeExecution checks the state again, synchronously).
  const run = resumeExecution(id, { kind: 'webhook', outputs: [[item]], ...(mode === 'responseNode' && { onReply: (value: RunReply) => reply.resolve(value) }) });
  run.catch((caught: unknown) => logger.warn('webhook resume failed', { 'landflow.execution.id': id, error: (caught as Error).message }));
  const response = await answerWebhook(mode, run, reply.promise, { executionId: id, workflowId: record.workflowId, status: 'resumed' }).catch((caught: unknown) => {
    if (caught instanceof ResumeError) return error(caught.message, caught.status);
    throw caught;
  });
  recordWebhookRequest(response.status, record.workflowId);
  return response;
}

export const GET = handler(handle);
export const POST = handler(handle);
export const PUT = handler(handle);
export const PATCH = handler(handle);
export const DELETE = handler(handle);
export const HEAD = handler(handle);
