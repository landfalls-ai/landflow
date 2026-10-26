/**
 * Test webhooks: /api/webhook-test/<path> answers one call while an editor listens for the Webhook trigger with that
 * path and method ("Listen for test event", POST /api/workflows/:id/listen), and 404 otherwise. The call runs the
 * workflow the editor sent when it started listening as a manual run, which the editor shows live; then the URL stops
 * answering until the editor listens again. As on /api/webhook/<path>: the trigger's authentication and IP allow-list
 * come first (a refused call doesn't use the listener up), the Respond setting picks the answer (immediately, when the
 * last node finishes, from a Respond to Webhook node, or streamed), and files arrive as `item.binary`. No idempotency
 * keys, concurrency limits or debounce: it is an editor run. See lib/server/test-webhooks.ts.
 */
import type { NodeItem } from '@landflow/protocol';
import { deleteExecutionBinary } from '@/lib/server/binary/access';
import { BinaryTooLargeError } from '@/lib/server/binary/store';
import { error, handler } from '@/lib/server/http';
import type { RunReply } from '@/lib/server/runner';
import { runStream, streamFormatOf } from '@/lib/server/streaming';
import { claimTestListener, failTestEvent, findTestListener, runTestEvent, TEST_PREFIX, testWebhookMiss } from '@/lib/server/test-webhooks';
import { checkWebhookAuth } from '@/lib/server/webhook-auth';
import { answerWebhook, deferred, requestItem, type RespondMode } from '@/lib/server/webhooks';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ path: string[] }> };

async function handle(request: Request, { params }: Ctx) {
  const path = (await params).path.join('/');
  const method = request.method.toUpperCase();
  const found = await findTestListener('webhook', path, method);
  if (!found) return testWebhookMiss(path, method);
  const { listener, node } = found;
  const auth = await checkWebhookAuth(request, listener.workflow.id, node);
  if (!auth.ok) return auth.response;
  // Single-shot: this call takes the listener (another one racing it gets the 404).
  if (!(await claimTestListener(listener))) return testWebhookMiss(path, method);

  const { executionId } = listener;
  const mode = (['immediately', 'lastNode', 'responseNode', 'streaming'].includes(String(node.parameters.respond)) ? node.parameters.respond : 'lastNode') as RespondMode;
  const options = (node.parameters.options ?? {}) as { rawBody?: boolean; binaryPropertyName?: string };
  let item: NodeItem;
  try {
    item = await requestItem(request, path, { executionId, rawBody: options.rawBody === true, binaryPropertyName: options.binaryPropertyName });
    const headers = item.json.headers as Record<string, string>;
    for (const name of auth.secretHeaders) delete headers[name];
    if (auth.jwtPayload) item.json.jwtPayload = auth.jwtPayload;
  } catch (caught) {
    void deleteExecutionBinary(executionId);
    failTestEvent(listener, `The test call to ${TEST_PREFIX.webhook}${path} failed: ${(caught as Error).message}`);
    if (caught instanceof BinaryTooLargeError) return error(caught.message, 413);
    throw caught;
  }

  const reply = deferred<RunReply>();
  const streamed = mode === 'streaming' ? runStream(streamFormatOf(request), { executionId }) : undefined;
  const { run, started } = runTestEvent(listener, item, {
    ...(mode === 'responseNode' && { onReply: (value: RunReply) => reply.resolve(value) }),
    ...(streamed && { streaming: true, onEvent: streamed.onEvent }),
  });
  const caught = await started;
  if (caught !== undefined) {
    void deleteExecutionBinary(executionId);
    return error((caught as Error)?.message ?? 'The test run could not start', 500, { executionId });
  }
  if (streamed) return streamed.respond(run);
  return answerWebhook(mode, run, reply.promise, { executionId, workflowId: listener.workflow.id });
}

export const GET = handler(handle);
export const POST = handler(handle);
export const PUT = handler(handle);
export const PATCH = handler(handle);
export const DELETE = handler(handle);
