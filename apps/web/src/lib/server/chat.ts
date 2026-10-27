/**
 * Chats of the Chat Message trigger (nodes/triggers.ts): the editor's chat panel (run route), and — for a trigger
 * made public — the hosted chat page, the embeddable widget and the chat API under /chat (app/chat/[...path]).
 *
 * - A public chat answers at /chat/<path> (the trigger's Path, else the workflow id) while the workflow is published.
 * - Messages may carry files (base64 from the editor, multipart from the page and widget); they are stored under
 *   the run's execution id and reach the trigger item as binary `data0`, `data1`…
 * - Transcripts of public chats are kept per workflow and session in `chat_messages` (migration 401) for
 *   "Load Previous Session".
 * - Allowed origins (CORS) and Basic Auth are the trigger's; the widget shows a sign-in form for a chat with Basic Auth
 *   and sends the credentials as an Authorization header (allowed over CORS), keeping them for the page session only.
 * - Each answer can be rated (thumbs up or down, a comment): lib/server/chat-feedback.ts, POST /chat/<key>/feedback.
 * - The trigger's Custom CSS styles the hosted page and the widget's shadow root, after `sanitizeCustomCss`.
 */
import { timingSafeEqual } from 'node:crypto';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { JsonObject, NodeItem } from '@landflow/protocol';
import { storeBinary } from './binary/access';
import type { FeedbackRating } from '../shared/chat-feedback';
import { feedbackBySession } from './chat-feedback';
import { database } from './db';
import { productionWorkflows } from './publish';

export const CHAT_TRIGGER = 'core.chatTrigger';
/** Files per message, and bytes per file, a chat accepts. */
export const MAX_CHAT_FILES = 10;
export const MAX_CHAT_FILE_BYTES = 20 * 1024 * 1024;
/** Kept transcript messages per session. */
const MAX_TRANSCRIPT = 200;

export interface ChatFile {
  fileName: string;
  mimeType: string;
  data: Uint8Array;
}

/** The trigger item of one chat message, its files stored in the execution's scope. */
export async function chatItem(message: { chatInput: string; sessionId: string; files?: ChatFile[] }, executionId: string): Promise<NodeItem> {
  const binary: NonNullable<NodeItem['binary']> = {};
  for (const [index, file] of (message.files ?? []).slice(0, MAX_CHAT_FILES).entries()) {
    binary[`data${index}`] = await storeBinary(executionId, file.data, { mimeType: file.mimeType || 'application/octet-stream', fileName: file.fileName });
  }
  return {
    json: {
      sessionId: message.sessionId,
      action: 'sendMessage',
      chatInput: message.chatInput,
      ...(message.files?.length && { files: message.files.map((f) => ({ fileName: f.fileName, mimeType: f.mimeType, fileSize: f.data.byteLength })) as unknown as JsonObject[] }),
    },
    ...(Object.keys(binary).length && { binary }),
  };
}

export interface PublicChatConfig {
  workflowId: string;
  nodeId: string;
  key: string;
  title: string;
  subtitle: string;
  inputPlaceholder: string;
  initialMessages: string[];
  responseMode: 'streaming' | 'lastNode';
  loadPreviousSession: boolean;
  allowFileUploads: boolean;
  allowedFilesMimeTypes: string;
  allowedOrigins: string[];
  /** The trigger's Custom CSS, sanitized (see `sanitizeCustomCss`). */
  customCss: string;
  basicAuth?: { user: string; password: string };
}

/** Longest Custom CSS kept (characters). */
export const MAX_CUSTOM_CSS = 20_000;

/**
 * Custom CSS of a public chat, made safe to serve to visitors: no `@import`, `@charset`, `@namespace`, no `url()` except
 * small inline `data:image/…;base64` images (so nothing is fetched from another site, and nothing leaks the visitor's
 * address), no `image-set()`/`src()`/`element()`, no legacy script hooks (`expression()`, `behavior`, `-moz-binding`,
 * `javascript:`), no comments and no `<`. CSS escapes (`\75 rl(`) are decoded first so they can't hide any of that.
 * Longer than `MAX_CUSTOM_CSS` characters: cut there.
 */
export function sanitizeCustomCss(input: string): string {
  let css = input.slice(0, MAX_CUSTOM_CSS * 2);
  // Escapes → the characters they stand for (those that could break out of a string or rule are dropped).
  css = css.replace(/\\([0-9a-fA-F]{1,6})\s?|\\([^\n0-9a-fA-F])/g, (_m, hex: string | undefined, other: string | undefined) => {
    const char = hex ? String.fromCodePoint(Math.min(parseInt(hex, 16) || 0xfffd, 0x10ffff)) : (other ?? '');
    return /["'\\{}();<>@/*\u0000]/.test(char) ? '' : char;
  });
  css = css.replace(/\/\*[\s\S]*?(\*\/|$)/g, ' ').replace(/<!--|-->/g, ' ');
  let previous: string;
  do {
    previous = css;
    css = css
      .replace(/@(import|charset|namespace)\b[^;{}]*;?/gi, '')
      .replace(/url\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (_m, a?: string, b?: string, c?: string) => {
        const target = (a ?? b ?? c ?? '').trim();
        return /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=]+$/i.test(target) ? `url("${target}")` : 'none';
      })
      .replace(/(?:-webkit-)?(?:image-set|cross-fade)\s*\([^)]*\)?|(?<![\w-])(?:src|element)\s*\([^)]*\)?|expression\s*\([^)]*\)?/gi, 'none')
      .replace(/javascript:|-moz-binding|(?<![\w-])behavior\s*:/gi, 'none')
      .replace(/[<>]/g, '');
  } while (css !== previous);
  return css.trim().slice(0, MAX_CUSTOM_CSS);
}

const text = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback);

/** A public chat trigger's settings. */
export function chatConfig(workflow: Workflow, node: WorkflowNode): PublicChatConfig {
  const p = node.parameters as Record<string, unknown>;
  const path = text(p.path).trim().replace(/^\/+|\/+$/g, '');
  return {
    workflowId: workflow.id,
    nodeId: node.id,
    key: path || workflow.id,
    title: text(p.title, 'Hi there! 👋'),
    subtitle: text(p.subtitle, 'Start a chat. We’re here to help you 24/7.'),
    inputPlaceholder: text(p.inputPlaceholder, 'Type your question…'),
    initialMessages: text(p.initialMessages, 'Hi there! 👋\nMy name is Nathan. How can I assist you today?')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
    responseMode: p.responseMode === 'lastNode' ? 'lastNode' : 'streaming',
    loadPreviousSession: p.loadPreviousSession !== false,
    allowFileUploads: p.allowFileUploads === true,
    allowedFilesMimeTypes: text(p.allowedFilesMimeTypes, 'image/*,application/pdf'),
    allowedOrigins: text(p.allowedOrigins, '*')
      .split(',')
      .map((origin) => origin.trim().replace(/\/+$/, ''))
      .filter(Boolean),
    customCss: sanitizeCustomCss(text(p.customCss)),
    ...(p.authentication === 'basicAuth' && { basicAuth: { user: text(p.basicAuthUser), password: text(p.basicAuthPassword) } }),
  };
}

/** The published workflow and public chat trigger answering at /chat/<key> (a path, or a workflow id). */
export function findPublicChat(key: string, workflows: Workflow[] = productionWorkflows()): { workflow: Workflow; node: WorkflowNode; config: PublicChatConfig } | undefined {
  const wanted = decodeURIComponent(key).replace(/^\/+|\/+$/g, '');
  if (!wanted) return undefined;
  let byId: { workflow: Workflow; node: WorkflowNode } | undefined;
  for (const workflow of workflows) {
    for (const node of workflow.nodes) {
      if (node.disabled || node.type !== CHAT_TRIGGER || node.parameters.public !== true) continue;
      const path = text(node.parameters.path).trim().replace(/^\/+|\/+$/g, '');
      if (path && path === wanted) return { workflow, node, config: chatConfig(workflow, node) };
      if (!path && workflow.id === wanted) byId ??= { workflow, node };
    }
  }
  return byId && { ...byId, config: chatConfig(byId.workflow, byId.node) };
}

/** Whether a browser on `origin` may call the chat (no Origin header: not a cross-site browser call). */
export function originAllowed(config: Pick<PublicChatConfig, 'allowedOrigins'>, origin: string | null): boolean {
  if (!origin) return true;
  if (config.allowedOrigins.includes('*')) return true;
  return config.allowedOrigins.some((allowed) => allowed.toLowerCase() === origin.toLowerCase().replace(/\/+$/, ''));
}

/** CORS headers for an allowed origin (none for a disallowed one: the browser blocks it). */
export function corsHeaders(config: Pick<PublicChatConfig, 'allowedOrigins'>, origin: string | null): Record<string, string> {
  if (!origin || !originAllowed(config, origin)) return {};
  return {
    'access-control-allow-origin': config.allowedOrigins.includes('*') ? '*' : origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, accept, authorization',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

const equal = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Basic Auth of the trigger: true when not required, or when the request carries the right user and password. */
export function basicAuthOk(config: Pick<PublicChatConfig, 'basicAuth'>, request: Request): boolean {
  if (!config.basicAuth) return true;
  const match = /^Basic\s+(.+)$/i.exec(request.headers.get('authorization') ?? '');
  if (!match) return false;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return false;
  return equal(decoded.slice(0, colon), config.basicAuth.user) && equal(decoded.slice(colon + 1), config.basicAuth.password);
}

/** Whether a file's MIME type is in the trigger's list (`image/*` style wildcards). */
export function mimeAllowed(allowed: string, mimeType: string): boolean {
  const type = mimeType.toLowerCase().split(';')[0].trim();
  const list = allowed
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (!list.length || list.includes('*') || list.includes('*/*')) return true;
  return list.some((entry) => (entry.endsWith('/*') ? type.startsWith(entry.slice(0, -1)) : entry === type));
}

// ---------------------------------------------------------------------------
// Transcripts ("Load Previous Session")
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  at: string;
  files?: Array<{ fileName: string; mimeType: string }>;
  /** An answer: the execution that wrote it, which the feedback buttons rate. */
  executionId?: string;
  /** The rating it got, if any. */
  feedback?: { rating: FeedbackRating; comment?: string };
}

const SESSION = /^[\w.:-]{1,128}$/;
export const validSessionId = (value: unknown): value is string => typeof value === 'string' && SESSION.test(value);

export function loadTranscript(workflowId: string, sessionId: string): ChatMessage[] {
  const rows = database().all<{ role: string; text: string; at: string; data: string | null }>(
    'SELECT role, text, at, data FROM chat_messages WHERE workflow_id = ? AND session_id = ? ORDER BY seq',
    workflowId,
    sessionId,
  );
  const ratings = feedbackBySession(workflowId, sessionId);
  return rows.map((row) => {
    let data: { files?: ChatMessage['files']; executionId?: string } = {};
    try {
      data = row.data ? (JSON.parse(row.data) as typeof data) : {};
    } catch {
      data = {};
    }
    const rated = data.executionId ? ratings.get(data.executionId) : undefined;
    return {
      role: row.role === 'assistant' ? 'assistant' : 'user',
      text: row.text,
      at: row.at,
      ...(data.files?.length && { files: data.files }),
      ...(data.executionId && { executionId: data.executionId }),
      ...(rated && { feedback: { rating: rated.rating, ...(rated.comment && { comment: rated.comment }) } }),
    };
  });
}

export function appendTranscript(workflowId: string, sessionId: string, messages: ChatMessage[]) {
  const db = database();
  db.transaction(() => {
    const last = db.get<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM chat_messages WHERE workflow_id = ? AND session_id = ?', workflowId, sessionId)?.seq ?? 0;
    let seq = Number(last);
    for (const message of messages) {
      seq += 1;
      db.upsert('chat_messages', {
        workflow_id: workflowId,
        session_id: sessionId,
        seq,
        role: message.role,
        text: message.text.slice(0, 100_000),
        at: message.at,
        data: message.files?.length || message.executionId ? JSON.stringify({ ...(message.files?.length && { files: message.files }), ...(message.executionId && { executionId: message.executionId }) }) : null,
      });
    }
    // Keep the newest messages only.
    if (seq > MAX_TRANSCRIPT) {
      for (const row of db.all<{ seq: number }>('SELECT seq FROM chat_messages WHERE workflow_id = ? AND session_id = ? AND seq <= ?', workflowId, sessionId, seq - MAX_TRANSCRIPT)) {
        db.delete('chat_messages', { workflow_id: workflowId, session_id: sessionId, seq: row.seq });
      }
    }
  });
}
