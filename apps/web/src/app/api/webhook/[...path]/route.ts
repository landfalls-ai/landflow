/**
 * Production webhooks: /api/webhook/<path> runs the *published* version of the workflow whose
 * Webhook trigger matches the path and method (draft and publish, lib/server/publish.ts). The
 * trigger's Authentication (Basic, Header or JWT Auth) and IP allow-list are checked first
 * (lib/server/webhook-auth.ts): a refused call gets 401/403 and starts nothing. The trigger's Respond setting
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
import { error, handler, json } from '@/lib/server/http';
import { findIdempotent, idempotencyKeyOf } from '@/lib/server/idempotency';
import { productionWorkflows } from '@/lib/server/publish';
import { DuplicateRunError, liveExecution, newExecutionId, RunBufferedError, runWorkflow, RunSkippedError, turnedDown, type RunReply } from '@/lib/server/runner';
import { store } from '@/lib/server/store';
import { recordWebhookRequest, startTrigger } from '@/lib/server/telemetry';
import { runStream, streamFormatOf } from '@/lib/server/streaming';
import { checkWebhookAuth } from '@/lib/server/webhook-auth';
import { answerWebhook, deferred, replayedResponse, requestItem, type RespondMode } from '@/lib/server/webhooks';
import { promoteExecution } from '@/lib/server/db/reads';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ path: string[] }> };

async function handle(request: Request, { params }: Ctx) {
  const path = (await params).path.join('/');
  const method = request.method.toUpperCase();
  const matches = productionWorkflows().flatMap((workflow) =>
    workflow.nodes
      .filter((n) => !n.disabled && n.type === 'core.webhook' && String(n.parameters.path ?? '').replace(/^\/+/, '') === path && String(n.parameters.method ?? 'POST') === method)
      .map((node) => ({ workflow, node })),
  );
  if (!matches.length) {
    recordWebhookRequest(404);
    return error(`No published workflow listens on ${method} /api/webhook/${path}`, 404);
  }

  const [{ workflow, node }] = matches;
  const auth = await checkWebhookAuth(request, workflow.id, node);
  if (!auth.ok) {
    recordWebhookRequest(auth.response.status, workflow.id);
    return auth.response;
  }
  const mode = (['immediately', 'lastNode', 'responseNode', 'streaming'].includes(String(node.parameters.respond)) ? node.parameters.respond : 'lastNode') as RespondMode;
  const idempotencyKey = idempotencyKeyOf(request);
  const replay = (id: string) => replayedResponse(mode, id, workflow.id, store.getExecution(id) ?? liveExecution(id));
  // A repeated call: answered before its body is read (the runner checks again, for calls that race).
  const earlier = idempotencyKey ? findIdempotent(workflow.id, idempotencyKey) : undefined;
  if (earlier) {
    recordWebhookRequest(200, workflow.id);
    await promoteExecution(earlier);
    return replay(earlier);
  }
  // Uploaded files are stored under the run's id before it starts; they go if it never does.
  const executionId = newExecutionId();
  const options = (node.parameters.options ?? {}) as { rawBody?: boolean; binaryPropertyName?: string };
  let item: NodeItem;
  try {
    item = await requestItem(request, path, { executionId, rawBody: options.rawBody === true, binaryPropertyName: options.binaryPropertyName });
    // The header that carried a Header Auth secret stays out of the run; a verified JWT's claims go in.
    const headers = item.json.headers as Record<string, string>;
    for (const name of auth.secretHeaders) delete headers[name];
    if (auth.jwtPayload) item.json.jwtPayload = auth.jwtPayload;
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
  // Streaming: AI Agent and chain output goes out as it arrives (SSE or NDJSON, lib/server/streaming.ts).
  const streamed = mode === 'streaming' ? runStream(streamFormatOf(request), { executionId }) : undefined;
  let started = false;
  const begun = deferred<void>();
  const run = context.with(trigger.context, () =>
    runWorkflow({
      workflow,
      mode: 'webhook',
      startNodeId: node.id,
      triggerItems: [item],
      executionId,
      ...(idempotencyKey && { idempotencyKey }),
      onStart: () => {
        started = true;
        begun.resolve();
      },
      ...(mode === 'responseNode' && { onReply: (value: RunReply) => reply.resolve(value) }),
      ...(streamed && { streaming: true, onEvent: streamed.onEvent }),
    }),
  );
  run.then(
    () => trigger.end(),
    (caught) => {
      // Held events keep their files: the later run reads them.
      if (!started && !(caught instanceof RunBufferedError)) void deleteExecutionBinary(executionId);
      trigger.end(caught);
    },
  );
  if (!started) {
    // Turned down before it started? (onStart comes synchronously, or a moment later in queue mode.)
    const caught = await turnedDown(run, begun.promise);
    if (caught instanceof DuplicateRunError) {
      await promoteExecution(caught.executionId);
      return respond(replay(caught.executionId));
    }
    // Held by the trigger's debounce or batching: accepted, a later run takes it.
    if (caught instanceof RunBufferedError) {
      return respond(json({ status: caught.reason, workflowId: workflow.id, message: caught.message, count: caught.count, runsAt: caught.dueAt, ...(caught.startedNow && { started: true }) }, 202));
    }
    if (caught instanceof RunSkippedError) return respond(error(caught.message, 429, { workflowId: workflow.id, reason: caught.reason }));
    if (caught !== undefined) throw caught;
  }
  // Held by the concurrency limit (queue mode: not just waiting for a worker).
  const stored = store.getExecution(executionId);
  const queued = stored?.status === 'queued' && !stored.queued?.worker;
  if (streamed) return respond(streamed.respond(run));
  return respond(await answerWebhook(mode, run, reply.promise, { executionId, workflowId: workflow.id, ...(queued && { status: 'queued' }) }));
}

export const GET = handler(handle);
export const POST = handler(handle);
export const PUT = handler(handle);
export const PATCH = handler(handle);
export const DELETE = handler(handle);
