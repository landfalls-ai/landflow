/**
 * Streamed HTTP answers of a run ("Streaming" response mode of the Webhook and Chat triggers, the hosted chat):
 * what AI Agent and chain nodes stream (`ctx.sendChunk` → `node.chunk` events) goes out as it arrives, as SSE
 * (`data: {…}` events, for `Accept: text/event-stream`) or NDJSON (one JSON object per line, n8n's format).
 *
 * Each chunk: `{ type: 'begin' | 'item' | 'end' | 'tool' | 'error', content?, tool?, metadata: { nodeId, nodeName,
 * itemIndex, timestamp }, agent?: { id, name, face? } }`. `agent` is there only when the node that wrote the chunk labels
 * it (see `chunkAgent`); a flow without labels streams exactly as before. The last one: `{ type: 'done', executionId, status, output?, error? }` with the
 * reply text (chat) or the last node's output, or `waiting` with the approval the run waits for.
 */
import type { ExecutionEvent } from '@landflow/engine';
import type { JsonObject } from '@landflow/protocol';
import type { ExecutionRecord } from '../shared/types';

export type StreamFormat = 'sse' | 'ndjson';

/** SSE when the client asks for it, else NDJSON. */
export const streamFormatOf = (request: Request): StreamFormat => (/text\/event-stream/i.test(request.headers.get('accept') ?? '') ? 'sse' : 'ndjson');

export const STREAM_HEADERS: Record<StreamFormat, Record<string, string>> = {
  sse: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' },
  ndjson: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' },
};

/** Who wrote a chunk: an agent's id and name, and how it looks (an emoji, an image URL or an avatar object). */
export interface ChunkAgent {
  id: string;
  name: string;
  face?: string | JsonObject;
}

/** The label a chunk carries (`chunk.agent`, set by the node that writes it), or undefined when absent or malformed. */
export function chunkAgent(chunk: unknown): ChunkAgent | undefined {
  const raw = (chunk as { agent?: unknown } | null)?.agent as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || typeof raw.name !== 'string' || !raw.id || !raw.name) return undefined;
  const face = typeof raw.face === 'string' ? raw.face.slice(0, 2_000) : raw.face && typeof raw.face === 'object' && !Array.isArray(raw.face) ? (raw.face as JsonObject) : undefined;
  return { id: raw.id.slice(0, 200), name: raw.name.slice(0, 200), ...(face !== undefined && { face }) };
}

/** A node.chunk event as a wire chunk. */
export function wireChunk(event: Extract<ExecutionEvent, { type: 'node.chunk' }>): JsonObject {
  const { chunk } = event;
  const agent = chunkAgent(chunk);
  return {
    type: chunk.type,
    ...(chunk.content !== undefined && { content: chunk.content }),
    ...(chunk.tool && { tool: chunk.tool as unknown as JsonObject }),
    ...(agent && { agent: agent as unknown as JsonObject }),
    metadata: { nodeId: event.nodeId, nodeName: event.nodeName, itemIndex: chunk.itemIndex ?? 0, timestamp: Date.parse(event.at) || Date.now() },
  };
}

/** The text a chat shows for a finished run: the last node's `output` / `text` / `reply` / `response`, else its JSON. */
export function replyText(record: Pick<ExecutionRecord, 'lastNodeId' | 'runData' | 'executionOrder'>): string {
  const lastId = record.lastNodeId ?? record.executionOrder?.at(-1);
  const json = (lastId ? record.runData[lastId]?.at(-1)?.outputs[0]?.[0]?.json : undefined) as JsonObject | undefined;
  if (!json) return '';
  for (const key of ['output', 'text', 'reply', 'response', 'message']) if (typeof json[key] === 'string') return json[key] as string;
  return JSON.stringify(json);
}

/** The last node's output: one item → its JSON, several → an array. */
export function lastOutput(record: Pick<ExecutionRecord, 'lastNodeId' | 'runData'>): unknown {
  const items = (record.lastNodeId ? record.runData[record.lastNodeId]?.at(-1)?.outputs[0] : undefined) ?? [];
  return items.length === 1 ? items[0].json : items.map((item) => item.json);
}

export interface RunStream {
  /** Hand to runWorkflow / resumeExecution as onEvent (with `streaming: true`). */
  onEvent: (event: ExecutionEvent) => void;
  /** Write any extra chunk (a session id, a notice). */
  write: (chunk: JsonObject) => void;
  /** The response: open until `run` settles, then the `done` chunk. */
  respond: (run: Promise<ExecutionRecord>, options?: { headers?: Record<string, string>; done?: (record: ExecutionRecord) => JsonObject }) => Response;
}

/** Stream a run's chunks as SSE or NDJSON. Chunks that arrive before the response is read are buffered. */
export function runStream(format: StreamFormat, options: { executionId?: string } = {}): RunStream {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let open = true;
  const backlog: Uint8Array[] = [];
  const encode = (chunk: JsonObject) => encoder.encode(format === 'sse' ? `data: ${JSON.stringify(chunk)}\n\n` : `${JSON.stringify(chunk)}\n`);
  const write = (chunk: JsonObject) => {
    if (!open) return;
    const bytes = encode(chunk);
    if (!controller) {
      backlog.push(bytes);
      return;
    }
    try {
      controller.enqueue(bytes);
    } catch {
      open = false;
    }
  };
  return {
    write,
    onEvent(event) {
      if (event.type === 'node.chunk') write(wireChunk(event));
    },
    respond(run, respondOptions = {}) {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
          for (const bytes of backlog.splice(0)) c.enqueue(bytes);
          run
            .then(
              (record) => write(respondOptions.done?.(record) ?? doneChunk(record)),
              (error: Error) => write({ type: 'done', status: 'error', ...(options.executionId && { executionId: options.executionId }), error: { message: error.message } }),
            )
            .finally(() => {
              open = false;
              try {
                c.close();
              } catch {}
            });
        },
        cancel() {
          // The client went away: the run goes on.
          open = false;
        },
      });
      return new Response(stream, { headers: { ...STREAM_HEADERS[format], ...respondOptions.headers, ...(options.executionId && { 'x-landflow-execution': options.executionId }) } });
    },
  };
}

/** The final chunk of a webhook stream: status and the last node's output. */
export function doneChunk(record: ExecutionRecord): JsonObject {
  return {
    type: 'done',
    executionId: record.executionId,
    status: record.status,
    ...(record.status === 'success' && { output: lastOutput(record) as JsonObject }),
    ...(record.error && { error: { message: record.error.message } }),
    ...(record.status === 'waiting' && record.wait?.data?.approval !== undefined && { approval: record.wait.data.approval }),
  };
}
