/**
 * Production webhooks: /api/webhook/<path> runs every *active* workflow whose
 * Webhook trigger matches the path and method. The trigger's Respond setting
 * picks the answer: immediately (202), when the last node finishes (its output),
 * or from a Respond to Webhook node (sent when that node runs, even if the run
 * continues). A run that starts waiting first answers `{ status: 'waiting' }`. Multipart files and
 * non-text bodies arrive as `item.binary` (413 past LANDFLOW_BINARY_MAX_BYTES).
 * Responses carry the run's `traceparent`.
 *
 * An `Idempotency-Key` header makes a retried call safe: the same key for the workflow within the
 * retention window (LANDFLOW_IDEMPOTENCY_TTL_HOURS, default 24) starts no new run and gets the first
 * run's answer back (`Idempotent-Replayed: true`). A workflow at its concurrency limit queues the run
 * (`status: 'queued'` when answering immediately) or, set to skip, answers 429.
 */
import { context } from '@opentelemetry/api';
import type { NodeItem } from '@landflow/protocol';
import { deleteExecutionBinary } from '@/lib/server/binary/access';
import { BinaryTooLargeError } from '@/lib/server/binary/store';
import { error, handler } from '@/lib/server/http';
import { findIdempotent, idempotencyKeyOf } from '@/lib/server/idempotency';
import { DuplicateRunError, liveExecution, newExecutionId, runWorkflow, RunSkippedError, type RunReply } from '@/lib/server/runner';
import { store } from '@/lib/server/store';
import { recordWebhookRequest, startTrigger } from '@/lib/server/telemetry';
import { answerWebhook, deferred, replayedResponse, requestItem, type RespondMode } from '@/lib/server/webhooks';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ path: string[] }> };

async function handle(request: Request, { params }: Ctx) {
  const path = (await params).path.join('/');
  const method = request.method.toUpperCase();
  const matches = store.listWorkflows().flatMap((workflow) =>
    workflow.active
      ? workflow.nodes
          .filter((n) => !n.disabled && n.type === 'core.webhook' && String(n.parameters.path ?? '').replace(/^\/+/, '') === path && String(n.parameters.method ?? 'POST') === method)
          .map((node) => ({ workflow, node }))
      : [],
  );
  if (!matches.length) {
    recordWebhookRequest(404);
    return error(`No active workflow listens on ${method} /api/webhook/${path}`, 404);
  }

  const [{ workflow, node }] = matches;
  const mode = (['immediately', 'lastNode', 'responseNode'].includes(String(node.parameters.respond)) ? node.parameters.respond : 'lastNode') as RespondMode;
  const idempotencyKey = idempotencyKeyOf(request);
  const replay = (id: string) => replayedResponse(mode, id, workflow.id, store.getExecution(id) ?? liveExecution(id));
  // A repeated call: answered before its body is read (the runner checks again, for calls that race).
  const earlier = idempotencyKey ? findIdempotent(workflow.id, idempotencyKey) : undefined;
  if (earlier) {
    recordWebhookRequest(200, workflow.id);
    return replay(earlier);
  }
  // Uploaded files are stored under the run's id before it starts; they go if it never does.
  const executionId = newExecutionId();
  const options = (node.parameters.options ?? {}) as { rawBody?: boolean; binaryPropertyName?: string };
  let item: NodeItem;
  try {
    item = await requestItem(request, path, { executionId, rawBody: options.rawBody === true, binaryPropertyName: options.binaryPropertyName });
  } catch (caught) {
    void deleteExecutionBinary(executionId);
    if (caught instanceof BinaryTooLargeError) {
      recordWebhookRequest(413, workflow.id);
      return error(caught.message, 413);
    }
    throw caught;
  }
  const trigger = startTrigger({ source: 'webhook', workflowId: workflow.id, nodeName: node.name });
  const respond = (response: Response) => {
    recordWebhookRequest(response.status, workflow.id);
    for (const [key, value] of Object.entries(trigger.headers)) response.headers.set(key, value);
    return response;
  };
  const reply = deferred<RunReply>();
  let started = false;
  const run = context.with(trigger.context, () =>
    runWorkflow({
      workflow,
      mode: 'webhook',
      startNodeId: node.id,
      triggerItems: [item],
      executionId,
      ...(idempotencyKey && { idempotencyKey }),
      onStart: () => (started = true),
      ...(mode === 'responseNode' && { onReply: (value: RunReply) => reply.resolve(value) }),
    }),
  );
  run.then(
    () => trigger.end(),
    (caught) => {
      if (!started) void deleteExecutionBinary(executionId);
      trigger.end(caught);
    },
  );
  if (!started) {
    // Turned down before it started (onStart is called synchronously otherwise).
    const caught = await run.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    if (caught instanceof DuplicateRunError) return respond(replay(caught.executionId));
    if (caught instanceof RunSkippedError) return respond(error(caught.message, 429, { workflowId: workflow.id, reason: caught.reason }));
    if (caught !== undefined) throw caught;
  }
  const queued = store.getExecution(executionId)?.status === 'queued';
  return respond(await answerWebhook(mode, run, reply.promise, { executionId, workflowId: workflow.id, ...(queued && { status: 'queued' }) }));
}

export const GET = handler(handle);
export const POST = handler(handle);
export const PUT = handler(handle);
export const PATCH = handler(handle);
export const DELETE = handler(handle);
