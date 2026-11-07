/**
 * Public chats of Chat Message triggers made public (lib/server/chat.ts), self-contained under /chat (public in
 * lib/shared/auth-paths.ts; the trigger's own Basic Auth and Allowed Origins apply):
 *
 * - GET  /chat/widget.js                  the chat script (hosted page and embeddable bubble)
 * - GET  /chat/<key>                      the hosted chat page (Basic Auth when the trigger asks for it)
 * - GET  /chat/<key>/config               title, initial messages, uploads… for the script
 * - GET  /chat/<key>/session?sessionId=   the session's earlier messages ("Load Previous Session"), with their ratings
 * - POST /chat/<key>/feedback             `{ sessionId, executionId, rating: 'up' | 'down' | null, comment? }`: rate an answer
 * - POST /chat/<key>                      a message: JSON `{ sessionId, message, agentKey? }` or multipart (`files`) →
 *                                         SSE / NDJSON chunks then `done` (Streaming), or `{ output, sessionId }`
 * - OPTIONS                               CORS preflight
 *
 * With Basic Auth the hosted page asks the browser for the password; the widget (any origin) sends the same
 * `Authorization: Basic …` header over CORS from its sign-in form, and a 401 answers JSON `{ authRequired: true }`.
 *
 * `<key>` is the trigger's Path, else the workflow id; the workflow must be published (active). Runs start in
 * webhook mode (production: counted in Insights, held by concurrency limits).
 */
import { context } from '@opentelemetry/api';
import type { ExecutionEvent } from '@landflow/engine';
import { deleteExecutionBinary } from '@/lib/server/binary/access';
import {
  agentSessionId,
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
  pickAgent,
  visibleTranscript,
  validSessionId,
  type ChatFile,
  type PublicChatConfig,
  chatStartNodeId,
} from '@/lib/server/chat';
import { CHAT_CLIENT_JS, chatPageHtml } from '@/lib/server/chat-client';
import { cleanComment, isRating, setFeedback } from '@/lib/server/chat-feedback';
import { handler } from '@/lib/server/http';
import { liveExecution, newExecutionId, RunBufferedError, runWorkflow, RunSkippedError, turnedDown } from '@/lib/server/runner';
import { store } from '@/lib/server/store';
import { chunkAgent, replyText, runStream, streamFormatOf } from '@/lib/server/streaming';
import { logger, startTrigger } from '@/lib/server/telemetry';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ path: string[] }> };

const MAX_MESSAGE_CHARS = 32_000;
/** The hosted page loads nothing from other sites, whatever the Custom CSS says (the sanitizer already removes external url()s). */
const PAGE_CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'self'";

function jsonResponse(data: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}

/** `/chat/<key>[/config|/session|/feedback]` → key and sub-path. */
function parse(path: string[]): { key: string; sub?: string } {
  const last = path.at(-1);
  if (path.length > 1 && (last === 'config' || last === 'session' || last === 'feedback')) return { key: path.slice(0, -1).join('/'), sub: last };
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
/** The widget's 401: JSON with CORS headers (no `www-authenticate`, so the browser doesn't open its own prompt over the site), plus what the sign-in form needs. */
const authRequired = (config: PublicChatConfig, cors: Record<string, string>) =>
  jsonResponse({ error: 'Sign in to use this chat', authRequired: true, title: config.title, subtitle: config.subtitle, customCss: config.customCss }, 401, { ...cors, 'cache-control': 'no-store' });

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
  if (!basicAuthOk(config, request)) return sub ? authRequired(config, access.cors) : askForAuth();
  if (!sub) {
    return new Response(chatPageHtml({ key: config.key, title: config.title }), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'SAMEORIGIN', 'content-security-policy': PAGE_CSP } });
  }
  if (sub === 'feedback') return jsonResponse({ error: 'Send feedback with POST' }, 405, access.cors);
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
        feedback: true,
        // Label and face only: never the node behind an agent.
        ...(config.roster.length && { agents: config.roster.map((r) => ({ key: r.key, label: r.label, ...(r.face && { face: r.face }) })) }),
        voice: config.voice,
        ...(config.voice !== 'off' && { ...(config.voiceLang && { voiceLang: config.voiceLang }), voiceSend: config.voiceSend }),
        customCss: config.customCss,
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
async function readMessage(request: Request, config: PublicChatConfig): Promise<{ sessionId: string; message: string; files: ChatFile[]; agentKey?: unknown } | { error: string; status: number }> {
  const type = request.headers.get('content-type') ?? '';
  let sessionId: unknown;
  let message: unknown;
  let agentKey: unknown;
  const files: ChatFile[] = [];
  if (type.includes('multipart/form-data')) {
    const form = await request.formData();
    sessionId = form.get('sessionId');
    message = form.get('message') ?? form.get('chatInput') ?? '';
    agentKey = form.get('agentKey') ?? undefined;
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
    let body: { sessionId?: unknown; message?: unknown; chatInput?: unknown; agentKey?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return { error: 'Send JSON { sessionId, message } or a multipart form', status: 400 };
    }
    sessionId = body.sessionId;
    message = body.message ?? body.chatInput;
    agentKey = body.agentKey;
  }
  if (!validSessionId(sessionId)) return { error: 'sessionId must be 1–128 letters, digits, dots, dashes, colons or underscores', status: 400 };
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text && !files.length) return { error: 'The message is empty', status: 400 };
  if (text.length > MAX_MESSAGE_CHARS) return { error: `Messages can be up to ${MAX_MESSAGE_CHARS} characters`, status: 413 };
  return { sessionId, message: text, files, agentKey };
}

/** Rate an answer: the execution must be this chat's, and (when its trigger item is still there) of this session. */
async function postFeedback(request: Request, found: NonNullable<ReturnType<typeof findPublicChat>>, cors: Record<string, string>): Promise<Response> {
  const { workflow, node } = found;
  let body: { sessionId?: unknown; executionId?: unknown; rating?: unknown; comment?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse({ error: 'Send JSON { sessionId, executionId, rating, comment? }' }, 400, cors);
  }
  if (!validSessionId(body.sessionId)) return jsonResponse({ error: 'sessionId must be 1–128 letters, digits, dots, dashes, colons or underscores' }, 400, cors);
  if (typeof body.executionId !== 'string' || !/^[\w-]{1,128}$/.test(body.executionId)) return jsonResponse({ error: 'executionId is the id the chat answered with' }, 400, cors);
  if (body.rating !== null && !isRating(body.rating)) return jsonResponse({ error: "rating is 'up', 'down' or null (take it back)" }, 400, cors);
  const record = liveExecution(body.executionId) ?? store.getExecution(body.executionId);
  if (!record || record.workflowId !== workflow.id) return jsonResponse({ error: 'That answer doesn’t belong to this chat' }, 404, cors);
  const asked = (record.runData[node.id]?.[0]?.outputs?.[0]?.[0]?.json as { sessionId?: unknown } | undefined)?.sessionId;
  if (typeof asked === 'string' && asked !== body.sessionId) return jsonResponse({ error: 'That answer belongs to another session' }, 403, cors);
  const feedback = setFeedback({ kind: 'execution', workflowId: workflow.id, executionId: body.executionId, sessionId: body.sessionId }, body.rating, { comment: cleanComment(body.comment), source: 'chat' });
  return jsonResponse({ ok: true, feedback: feedback ?? null }, 200, cors);
}

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { key, sub } = parse((await params).path);
  if (sub && sub !== 'feedback') return notFound();
  const found = findPublicChat(key);
  if (!found) return notFound();
  const { workflow, node, config } = found;
  const access = allowedFor(config, request);
  if (!access.ok) return jsonResponse({ error: 'This site may not use this chat (Allowed Origins)' }, 403);
  if (!basicAuthOk(config, request)) return authRequired(config, access.cors);
  if (sub === 'feedback') return postFeedback(request, found, access.cors);
  const parsed = await readMessage(request, config);
  if ('error' in parsed) return jsonResponse({ error: parsed.error }, parsed.status, access.cors);

  // A visitor may name only an agent on the roster; nothing named: the flow's lead (the trigger's own start).
  const picked = pickAgent(config.roster, parsed.agentKey);
  if ('error' in picked) return jsonResponse({ error: picked.error }, 400, access.cors);
  const agent = picked.entry;
  const executionId = newExecutionId();
  const item = await chatItem(
    {
      chatInput: parsed.message,
      // The picked agent keeps its own memory (`<sessionId>:<agentKey>`); the visible transcript stays under the visitor's session.
      sessionId: agent ? agentSessionId(parsed.sessionId, agent.key) : parsed.sessionId,
      files: parsed.files,
      ...(agent && { extra: { agentKey: agent.key, visitorSessionId: parsed.sessionId, ...(agent.seesTranscript && config.loadPreviousSession && { transcript: visibleTranscript(workflow.id, parsed.sessionId) }) } }),
    },
    executionId,
  );
  const at = new Date().toISOString();
  const fileList = parsed.files.map((f) => ({ fileName: f.fileName, mimeType: f.mimeType }));
  const streaming = config.responseMode === 'streaming';
  const stream = streaming ? runStream(streamFormatOf(request), { executionId }) : undefined;
  // Who wrote the answer, when the flow labels its agents (the last labelled text chunk).
  let speaker: ReturnType<typeof chunkAgent>;
  const trigger = startTrigger({ source: 'chat', workflowId: workflow.id, nodeName: node.name });
  let started = false;
  let markStarted!: () => void;
  const begun = new Promise<void>((resolve) => (markStarted = resolve));
  const run = context.with(trigger.context, () =>
    runWorkflow({
      workflow,
      mode: 'webhook',
      // A flow that routes on `agentKey` is started at the trigger, so its Guardrails run for the picked agent too.
      startNodeId: chatStartNodeId(workflow, node, agent),
      triggerItems: [item],
      executionId,
      onStart: () => {
        started = true;
        markStarted();
      },
      ...(stream && {
        streaming: true,
        onEvent: (event: ExecutionEvent) => {
          if (event.type === 'node.chunk' && event.chunk.type === 'item') speaker = chunkAgent(event.chunk) ?? speaker;
          stream.onEvent(event);
        },
      }),
    }),
  );
  // The transcript, for "Load Previous Session": the question now, the answer once the run ends.
  const settled = run.then(
    (record) => {
      trigger.end();
      const reply = record.status === 'success' ? replyText(record) : '';
      if (config.loadPreviousSession) appendTranscript(workflow.id, parsed.sessionId, [{ role: 'user', text: parsed.message, at, ...(agent && { agentKey: agent.key, agentName: agent.label }), ...(fileList.length && { files: fileList }) }, ...(reply ? [{ role: 'assistant' as const, text: reply, at: new Date().toISOString(), executionId: record.executionId, ...(agent ? { agentKey: agent.key, agentName: speaker?.name ?? agent.label } : speaker && { agentKey: speaker.id, agentName: speaker.name }) }] : [])]);
      return record;
    },
    (caught: unknown) => {
      trigger.end(caught);
      if (!started) void deleteExecutionBinary(executionId);
      throw caught;
    },
  );
  if (!started) {
    // Turned down before it started? (onStart comes synchronously, or a moment later in queue mode.)
    const caught = await turnedDown(settled, begun);
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
