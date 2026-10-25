/**
 * HTTP side of webhook-started and webhook-resumed runs: the request as an item, and the
 * response in each of the Webhook trigger's modes (immediately, when the last node finishes,
 * or from a Respond to Webhook node). Used by /api/webhook/* and /api/waiting/:executionId.
 */
import type { JsonObject, NodeItem } from '@landflow/protocol';
import type { ExecutionRecord } from '../shared/types';
import { fileResponseHeaders, readRequestBody, type RequestBodyOptions } from './binary/http';
import { error, json } from './http';
import type { RunReply } from './runner';

export type RespondMode = 'immediately' | 'lastNode' | 'responseNode';

/**
 * `{ method, path, headers, query, body }`; cookies and the Authorization header are left out. Uploaded files
 * (multipart parts, a non-text body, or any body with `rawBody`) are stored in the execution's scope and
 * become `item.binary` (lib/server/binary/http.ts).
 */
export async function requestItem(request: Request, path: string, files: RequestBodyOptions): Promise<NodeItem> {
  const method = request.method.toUpperCase();
  const url = new URL(request.url);
  const { body, binary } = await readRequestBody(request, files);
  return {
    json: {
      method,
      path,
      headers: Object.fromEntries([...request.headers].filter(([k]) => !['cookie', 'authorization'].includes(k))),
      query: Object.fromEntries(url.searchParams),
      body: body as JsonObject[string],
    },
    ...(binary && { binary }),
  };
}

/** A promise with its resolve function, for the reply a run hands over while it continues. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Respond to Webhook's reply as an HTTP response. */
export function replyResponse(reply: Extract<RunReply, { type: 'webhook' }>, executionId?: string): Response {
  const headers = new Headers(reply.headers);
  if (executionId) headers.set('x-landflow-execution', executionId);
  if (reply.redirect) {
    headers.set('location', reply.redirect);
    return new Response(null, { status: reply.status >= 300 && reply.status < 400 ? reply.status : 307, headers });
  }
  if (reply.file) {
    const download = fileResponseHeaders(reply.file);
    for (const key of ['content-type', 'content-length', 'content-disposition', 'x-content-type-options']) if (!headers.has(key)) headers.set(key, download.get(key)!);
    return new Response(reply.file.stream, { status: reply.status, headers });
  }
  if (reply.json !== undefined) {
    if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(reply.json), { status: reply.status, headers });
  }
  if (reply.body !== undefined) {
    if (!headers.has('content-type')) headers.set('content-type', 'text/plain; charset=utf-8');
    return new Response(reply.body, { status: reply.status, headers });
  }
  return new Response(null, { status: reply.status, headers });
}

/** The last node's output as JSON (one item → the object, several → an array). */
export function lastNodeResponse(record: ExecutionRecord): Response {
  if (record.status === 'waiting') return json({ status: 'waiting', executionId: record.executionId });
  if (record.status !== 'success') return error(record.error?.message ?? 'Execution failed', 500, { executionId: record.executionId });
  const lastRuns = record.lastNodeId ? record.runData[record.lastNodeId] : undefined;
  const items = lastRuns?.at(-1)?.outputs[0] ?? [];
  return json(items.length === 1 ? items[0].json : items.map((i) => i.json), { headers: { 'x-landflow-execution': record.executionId } });
}

/**
 * The answer to a webhook call that repeats an earlier one (same Idempotency-Key): the finished run's
 * last-node output in "when the last node finishes" mode, else the run's status. Marked `Idempotent-Replayed: true`.
 */
export function replayedResponse(mode: RespondMode, executionId: string, workflowId: string, record: ExecutionRecord | undefined): Response {
  const response =
    mode === 'lastNode' && record?.status === 'success'
      ? lastNodeResponse(record)
      : json({ status: record?.status ?? 'started', workflowId, executionId }, { headers: { 'x-landflow-execution': executionId } });
  response.headers.set('idempotent-replayed', 'true');
  return response;
}

/**
 * Answer a webhook request in one of the response modes. `run` settles when the run finishes or
 * starts waiting; `reply` when a Respond to Webhook node runs (the run may continue after it).
 */
export async function answerWebhook(
  mode: RespondMode,
  run: Promise<ExecutionRecord>,
  reply: Promise<RunReply>,
  started: { executionId?: string; workflowId: string; status?: string },
): Promise<Response> {
  if (mode === 'immediately') return json({ status: started.status ?? 'started', workflowId: started.workflowId, executionId: started.executionId }, 202);
  if (mode === 'responseNode') {
    const outcome = await Promise.race([
      reply.then((value) => ({ reply: value }) as const),
      run.then((record) => ({ record }) as const),
    ]);
    if ('reply' in outcome) {
      if (outcome.reply.type === 'webhook') return replyResponse(outcome.reply, started.executionId);
      return json({ status: 'started', executionId: started.executionId }, 202);
    }
    const { record } = outcome;
    if (record.status === 'waiting') return json({ status: 'waiting', executionId: record.executionId });
    if (record.status !== 'success') return error(record.error?.message ?? 'Execution failed', 500, { executionId: record.executionId });
    return json({ status: 'finished', executionId: record.executionId, message: 'The workflow finished without running a Respond to Webhook node' });
  }
  return lastNodeResponse(await run);
}
