/**
 * Public chats of Chat Message triggers made public (lib/server/chat.ts), self-contained under /chat (public in
 * lib/shared/auth-paths.ts; the trigger's own Basic Auth and Allowed Origins apply):
 *
 * - GET  /chat/widget.js                  the chat script (hosted page and embeddable bubble)
 * - GET  /chat/<key>                      the hosted chat page (Basic Auth when the trigger asks for it)
 * - GET  /chat/<key>/config               title, initial messages, uploads… for the script
 * - GET  /chat/<key>/session?sessionId=   the session's earlier messages ("Load Previous Session")
 * - POST /chat/<key>                      a message: JSON `{ sessionId, message }` or multipart (`files`) →
 *                                         SSE / NDJSON chunks then `done` (Streaming), or `{ output, sessionId }`
 * - OPTIONS                               CORS preflight
 *
 * `<key>` is the trigger's Path, else the workflow id; the workflow must be published (active). Runs start in
 * webhook mode (production: counted in Insights, held by concurrency limits).
 */
import { context } from '@opentelemetry/api';
import { deleteExecutionBinary } from '@/lib/server/binary/access';
import {
  appendTranscript,
  basicAuthOk,
  chatItem,
  corsHeaders,
  findPublicChat,
  loadTranscript,
  MAX_CHAT_FILE_BYTES,
  MAX_CHAT_FILES,
  mimeAllowed,
  originAllowed,
  validSessionId,
  type ChatFile,
  type PublicChatConfig,
} from '@/lib/server/chat';
import { CHAT_CLIENT_JS, chatPageHtml } from '@/lib/server/chat-client';
import { handler } from '@/lib/server/http';
import { newExecutionId, RunBufferedError, runWorkflow, RunSkippedError } from '@/lib/server/runner';
import { replyText, runStream, streamFormatOf } from '@/lib/server/streaming';
import { logger, startTrigger } from '@/lib/server/telemetry';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ path: string[] }> };

const MAX_MESSAGE_CHARS = 32_000;

function jsonResponse(data: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}

/** `/chat/<key>[/config|/session]` → key and sub-path. */
function parse(path: string[]): { key: string; sub?: string } {
  const last = path.at(-1);
  if (path.length > 1 && (last === 'config' || last === 'session')) return { key: path.slice(0, -1).join('/'), sub: last };
  return { key: path.join('/') };
}

/** The request's own origin is always allowed (the hosted page); others need the trigger's Allowed Origins. */
function allowedFor(config: PublicChatConfig, request: Request): { ok: boolean; cors: Record<string, string> } {
  const origin = request.headers.get('origin');
  const own = new URL(request.url).origin;
  const forwarded = request.headers.get('x-forwarded-host');
  const same = !origin || origin === own || (forwarded !== null && origin.replace(/^https?:\/\//, '') === forwarded);
  return { ok: same || originAllowed(config, origin), cors: same ? {} : corsHeaders(config, origin) };
}

const notFound = (cors: Record<string, string> = {}) => jsonResponse({ error: 'This chat doesn’t exist, or its workflow isn’t published' }, 404, cors);
const askForAuth = () => new Response('Authentication required', { status: 401, headers: { 'www-authenticate': 'Basic realm="Landflow chat", charset="UTF-8"', 'content-type': 'text/plain; charset=utf-8' } });

export const GET = handler(async (request: Request, { params }: Ctx) => {
  const path = (await params).path;
  if (path.length === 1 && path[0] === 'widget.js') {
    return new Response(CHAT_CLIENT_JS, {
      headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff' },
    });
  }
  const { key, sub } = parse(path);
  const found = findPublicChat(key);
  if (!found) return sub ? notFound() : new Response('This chat doesn’t exist, or its workflow isn’t published.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  const { config } = found;
  const access = allowedFor(config, request);
  if (!access.ok) return jsonResponse({ error: 'This site may not use this chat (Allowed Origins)' }, 403);
  if (!basicAuthOk(config, request)) return askForAuth();
  if (!sub) {
    return new Response(chatPageHtml({ key: config.key, title: config.title }), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'SAMEORIGIN' } });
  }
  if (sub === 'config') {
    return jsonResponse(
      {
        key: config.key,
        title: config.title,
        subtitle: config.subtitle,
        inputPlaceholder: config.inputPlaceholder,
        initialMessages: config.initialMessages,
        responseMode: config.responseMode,
        loadPreviousSession: config.loadPreviousSession,
        allowFileUploads: config.allowFileUploads,
        allowedFilesMimeTypes: config.allowedFilesMimeTypes,
      },
      200,
      { ...access.cors, 'cache-control': 'no-store' },
    );
  }
  const sessionId = new URL(request.url).searchParams.get('sessionId');
  if (!config.loadPreviousSession || !validSessionId(sessionId)) return jsonResponse({ messages: [] }, 200, access.cors);
  return jsonResponse({ sessionId, messages: loadTranscript(config.workflowId, sessionId) }, 200, { ...access.cors, 'cache-control': 'no-store' });
});

export const OPTIONS = handler(async (request: Request, { params }: Ctx) => {
  const path = (await params).path;
  if (path.length === 1 && path[0] === 'widget.js') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*' } });
  const found = findPublicChat(parse(path).key);
  if (!found) return new Response(null, { status: 404 });
  const access = allowedFor(found.config, request);
  return new Response(null, { status: access.ok ? 204 : 403, headers: access.cors });
});

/** The message from a JSON or multipart body. */
async function readMessage(request: Request, config: PublicChatConfig): Promise<{ sessionId: string; message: string; files: ChatFile[] } | { error: string; status: number }> {
  const type = request.headers.get('content-type') ?? '';
  let sessionId: unknown;
  let message: unknown;
  const files: ChatFile[] = [];
  if (type.includes('multipart/form-data')) {
    const form = await request.formData();
    sessionId = form.get('sessionId');
    message = form.get('message') ?? form.get('chatInput') ?? '';
    for (const entry of form.getAll('files')) {
      if (typeof entry === 'string') continue;
      if (!config.allowFileUploads) return { error: 'This chat doesn’t take files', status: 400 };
      if (files.length >= MAX_CHAT_FILES) return { error: `At most ${MAX_CHAT_FILES} files per message`, status: 400 };
      if (entry.size > MAX_CHAT_FILE_BYTES) return { error: `${entry.name} is larger than 20 MB`, status: 413 };
      const mimeType = entry.type || 'application/octet-stream';
      if (!mimeAllowed(config.allowedFilesMimeTypes, mimeType)) return { error: `${entry.name}: ${mimeType} files aren’t allowed here`, status: 415 };
      files.push({ fileName: entry.name || 'file', mimeType, data: new Uint8Array(await entry.arrayBuffer()) });
    }
  } else {
    let body: { sessionId?: unknown; message?: unknown; chatInput?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return { error: 'Send JSON { sessionId, message } or a multipart form', status: 400 };
    }
    sessionId = body.sessionId;
    message = body.message ?? body.chatInput;
  }
  if (!validSessionId(sessionId)) return { error: 'sessionId must be 1–128 letters, digits, dots, dashes, colons or underscores', status: 400 };
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text && !files.length) return { error: 'The message is empty', status: 400 };
  if (text.length > MAX_MESSAGE_CHARS) return { error: `Messages can be up to ${MAX_MESSAGE_CHARS} characters`, status: 413 };
  return { sessionId, message: text, files };
}

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { key, sub } = parse((await params).path);
  const found = sub ? undefined : findPublicChat(key);
  if (!found) return notFound();
  const { workflow, node, config } = found;
  const access = allowedFor(config, request);
  if (!access.ok) return jsonResponse({ error: 'This site may not use this chat (Allowed Origins)' }, 403);
  if (!basicAuthOk(config, request)) return askForAuth();
  const parsed = await readMessage(request, config);
  if ('error' in parsed) return jsonResponse({ error: parsed.error }, parsed.status, access.cors);

  const executionId = newExecutionId();
  const item = await chatItem({ chatInput: parsed.message, sessionId: parsed.sessionId, files: parsed.files }, executionId);
  const at = new Date().toISOString();
  const fileList = parsed.files.map((f) => ({ fileName: f.fileName, mimeType: f.mimeType }));
  const streaming = config.responseMode === 'streaming';
  const stream = streaming ? runStream(streamFormatOf(request), { executionId }) : undefined;
  const trigger = startTrigger({ source: 'chat', workflowId: workflow.id, nodeName: node.name });
  let started = false;
  const run = context.with(trigger.context, () =>
    runWorkflow({
      workflow,
      mode: 'webhook',
      startNodeId: node.id,
      triggerItems: [item],
      executionId,
      onStart: () => (started = true),
      ...(stream && { streaming: true, onEvent: stream.onEvent }),
    }),
  );
  // The transcript, for "Load Previous Session": the question now, the answer once the run ends.
  const settled = run.then(
    (record) => {
      trigger.end();
      const reply = record.status === 'success' ? replyText(record) : '';
      if (config.loadPreviousSession) appendTranscript(workflow.id, parsed.sessionId, [{ role: 'user', text: parsed.message, at, ...(fileList.length && { files: fileList }) }, ...(reply ? [{ role: 'assistant' as const, text: reply, at: new Date().toISOString() }] : [])]);
      return record;
    },
    (caught: unknown) => {
      trigger.end(caught);
      if (!started) void deleteExecutionBinary(executionId);
      throw caught;
    },
  );
  if (!started) {
    const caught = await settled.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    if (caught instanceof RunBufferedError) return jsonResponse({ output: '', status: caught.reason, sessionId: parsed.sessionId }, 202, access.cors);
    if (caught instanceof RunSkippedError) return jsonResponse({ error: 'Too many chats right now — try again in a moment' }, 429, access.cors);
    if (caught !== undefined) throw caught;
  }
  if (stream) {
    return stream.respond(settled, {
      headers: access.cors,
      done: (record) => ({
        type: 'done',
        executionId: record.executionId,
        sessionId: parsed.sessionId,
        status: record.status,
        ...(record.status === 'success' && { output: replyText(record) }),
        ...(record.error && { error: { message: record.error.message } }),
      }),
    });
  }
  try {
    const record = await settled;
    if (record.status === 'error') return jsonResponse({ error: record.error?.message ?? 'The workflow failed', executionId }, 500, access.cors);
    return jsonResponse({ output: record.status === 'success' ? replyText(record) : '', status: record.status, sessionId: parsed.sessionId, executionId }, 200, access.cors);
  } catch (caught) {
    logger.warn('public chat run failed', { 'landflow.workflow.id': workflow.id, error: (caught as Error).message });
    return jsonResponse({ error: (caught as Error).message }, 500, access.cors);
  }
});
