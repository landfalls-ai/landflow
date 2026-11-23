/**
 * Asking in chat (docs/access-requests.md#asking-in-chat). The chat flow's agent has one tool, File Access Request, which can only file
 * a request. The server, not the model, enforces the confirmation: a call without `confirmToken` files nothing and answers a summary and
 * a token; a call with that token files, only from a LATER run of the same person (a later chat turn), within 15 minutes, with the
 * very same fields. So the model can't ask and file in one turn, and a request never goes in that the person did not read back.
 * The requester is the run's `startedBy`, never a parameter.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { durationText } from '../../shared/access';
import { getUser } from '../auth/users';
import { credentials } from '../credentials/vault';
import { database } from '../db';
import { workflowForCall } from '../publish';
import { chatItem } from '../chat';
import { liveExecution, newExecutionId, runWorkflow } from '../runner';
import { replyText } from '../streaming';
import { store } from '../store';
import type { Actor } from '../projects/access';
import { AccessError } from './errors';
import { listEntries } from './catalog';
import { createRequest, summaryText } from './requests';
import { entryData } from './catalog';
import { accessSettings, accountOf, requestRow } from './store';
import { validateGithubLogin } from './systems';

export const TOKEN_MINUTES = 15;
const key = () => credentials.deriveKey('access.chat');

interface TokenPayload {
  u: string;
  e: string;
  d: number | null;
  r: string;
  a: string;
  /** The run that read it back: the token files only from another. */
  x: string;
  /** Expiry, ms since the epoch. */
  t: number;
}

const b64 = (buffer: Buffer) => buffer.toString('base64url');

export function signToken(payload: TokenPayload): string {
  const body = b64(Buffer.from(JSON.stringify(payload)));
  return `${body}.${b64(createHmac('sha256', key()).update(body).digest())}`;
}

export function verifyToken(token: string): TokenPayload | undefined {
  const [body, signature, extra] = String(token).split('.');
  if (!body || !signature || extra !== undefined) return undefined;
  const given = Buffer.from(signature, 'base64url');
  const valid = credentials.deriveKeys('access.chat').some((candidate) => {
    const expected = createHmac('sha256', candidate).update(body).digest();
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!valid) return undefined;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
  } catch {
    return undefined;
  }
}

/** "15", "15 min", "1 h", "2 hours", "1 day", "7 days", "unlimited": minutes, or null for unlimited; undefined when it is not a duration. */
export function parseDuration(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return undefined;
  if (/^(unlimited|forever|permanent|no end|no limit|none)$/.test(text)) return null;
  const match = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)?$/.exec(text);
  if (!match) return undefined;
  const n = Number(match[1]);
  const unit = match[2] ?? 'min';
  const minutes = unit.startsWith('m') ? n : unit.startsWith('h') ? n * 60 : unit.startsWith('d') ? n * 1_440 : n * 10_080;
  return Number.isInteger(minutes) ? minutes : undefined;
}

export interface ChatCall {
  /** The person who sent the chat message (the run's `startedBy`); undefined for a run nobody signed in for. */
  userId: string | undefined;
  executionId: string;
  entry?: unknown;
  duration?: unknown;
  reason?: unknown;
  account?: unknown;
  confirmToken?: unknown;
}

export interface ChatAnswer {
  status: 'confirm' | 'filed' | 'need' | 'refused';
  message: string;
  summary?: string;
  confirmToken?: string;
  requestId?: string;
  state?: string;
  candidates?: string[];
  durations?: string[];
}

const actorOf = (userId: string): Actor | undefined => {
  const user = getUser(userId);
  return user && !user.disabledAt ? { id: user.id, role: user.role } : undefined;
};

/** The File Access Request tool. Never grants and never approves. */
export async function fileAccessFromChat(call: ChatCall): Promise<ChatAnswer> {
  const actor = call.userId ? actorOf(call.userId) : undefined;
  if (!actor) return { status: 'refused', message: 'Sign in on the Access page to ask for access.' };
  const text = (value: unknown) => String(value ?? '').trim();
  const entries = listEntries(actor);
  const wanted = text(call.entry);
  if (!wanted) return { status: 'need', message: 'Which access do you want?', candidates: entries.map((e) => e.name) };
  const lower = wanted.toLowerCase();
  const exact = entries.filter((e) => e.id === wanted || e.name.toLowerCase() === lower);
  const matches = exact.length ? exact : entries.filter((e) => e.name.toLowerCase().includes(lower));
  if (matches.length === 0) return { status: 'need', message: `I found no access called “${wanted}”. These are available:`, candidates: entries.map((e) => e.name) };
  if (matches.length > 1) return { status: 'need', message: `More than one access matches “${wanted}”. Which one?`, candidates: matches.map((e) => e.name) };
  const entry = matches[0]!;
  const minutes = parseDuration(call.duration);
  if (minutes === undefined || !entry.durations.includes(minutes)) {
    return { status: 'need', message: `${entry.name} can be asked for ${entry.durations.map(durationText).join(', ')}. Which one?`, durations: entry.durations.map(durationText) };
  }
  const reason = text(call.reason);
  if (reason.length < 3) return { status: 'need', message: 'Why do you need it? A short reason is enough.' };
  if (reason.length > 500) return { status: 'need', message: 'Please shorten the reason to 500 characters.' };
  let account = '';
  if (entry.system.startsWith('github')) {
    const given = text(call.account);
    const kept = accountOf(actor.id, 'github');
    if (!given && !kept) return { status: 'need', message: 'What is your GitHub username?' };
    try {
      account = given ? validateGithubLogin(given) : kept!;
    } catch (error) {
      return { status: 'need', message: (error as Error).message };
    }
  } else if (entry.system === 'google-group') account = getUser(actor.id)?.email ?? '';

  const token = text(call.confirmToken);
  if (!token) {
    const data = entryData(entry.id)!;
    const summary = summaryText(data, getUser(actor.id)?.name || actor.id, minutes, reason, account || undefined);
    const confirmToken = signToken({ u: actor.id, e: entry.id, d: minutes, r: reason, a: account, x: call.executionId, t: Date.now() + TOKEN_MINUTES * 60_000 });
    return { status: 'confirm', message: 'Read this back to the person and file it only after they say yes in their next message.', summary, confirmToken };
  }
  const payload = verifyToken(token);
  if (!payload || payload.t < Date.now()) return { status: 'refused', message: 'That confirmation has expired or is not valid. Read the request back again.' };
  if (payload.u !== actor.id) return { status: 'refused', message: 'That confirmation was made for someone else.' };
  if (payload.x === call.executionId) return { status: 'refused', message: 'Ask the person to confirm in their next message, then file it.' };
  if (payload.e !== entry.id || payload.d !== minutes || payload.r !== reason || payload.a !== account) return { status: 'refused', message: 'The request changed since it was read back. Read it back again.' };
  try {
    const request = await createRequest(actor, { entryId: entry.id, durationMinutes: minutes, reason, ...(entry.system.startsWith('github') && { account }), channel: 'chat' });
    return { status: 'filed', message: `Your request was filed. ${request.approverNames.join(', ')} will decide it.`, requestId: request.id, state: request.status };
  } catch (error) {
    if (error instanceof AccessError) return { status: 'refused', message: error.message, ...(typeof error.details?.existingId === 'string' && { requestId: error.details.existingId }) };
    throw error;
  }
}

export interface ChatReply {
  reply: string;
  requestId?: string;
}

/** The chat flow in `chat` mode as the session user: one message in, the agent's reply out. */
export async function runAccessChat(actor: Actor, input: { message: string; sessionId: string }): Promise<ChatReply> {
  const flowId = accessSettings().chatWorkflowId;
  const workflow = flowId ? workflowForCall(flowId, 'trigger') : undefined;
  const trigger = workflow?.nodes.find((n) => n.type === 'core.chatTrigger' && !n.disabled);
  if (!workflow || !trigger) throw new AccessError('The access chat is not set up. Ask an admin, or use the form.', 409);
  const executionId = newExecutionId();
  const started = new Date().toISOString();
  const item = await chatItem({ chatInput: input.message, sessionId: `access:${actor.id}:${input.sessionId}`, files: [] }, executionId);
  const record = await runWorkflow({ workflow, mode: 'chat', startNodeId: trigger.id, triggerItems: [item], executionId, streaming: true, startedBy: actor.id });
  const done = liveExecution(record.executionId) ?? record;
  const filed = database().get<{ id: string }>(`SELECT id FROM access_requests WHERE requester_id = ? AND channel = 'chat' AND created_at >= ? ORDER BY created_at DESC LIMIT 1`, actor.id, started);
  if (record.status === 'error') throw new AccessError(record.error?.message ?? 'The access chat failed', 502);
  return { reply: replyText(done) || 'I have nothing to add.', ...(filed && requestRow(filed.id) && { requestId: filed.id }) };
}
