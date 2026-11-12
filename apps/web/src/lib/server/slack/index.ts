/**
 * Slack on the host side: the Web API calls Landflow makes itself (agent channel replies, approval
 * messages), verification of the requests Slack sends (Events API, Interactivity), and the Block Kit of
 * the approval buttons. The bot token, the Web API base URL and the signing secret come from a
 * `messaging.slackApi` or `messaging.slackOAuth2Api` credential (the messaging plugin's), so a test double works through `baseUrl`.
 *
 * Request verification (https://api.slack.com/authentication/verifying-requests-from-slack): HMAC-SHA256
 * of `v0:<X-Slack-Request-Timestamp>:<raw body>` with the signing secret, compared in constant time with
 * `X-Slack-Signature` (`v0=<hex>`); requests older than five minutes are refused (replays).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { JsonObject } from '@landflow/protocol';
import { freshCredentials } from '../credentials/oauth2-runtime';
import { credentials } from '../credentials/vault';
import { singleton } from '../singleton';

export const SLACK_CREDENTIAL = 'messaging.slackApi';
/** The OAuth2 variant (Connect installs the app and stores the bot token): same fields, the host renews the token. */
export const SLACK_OAUTH2_CREDENTIAL = 'messaging.slackOAuth2Api';
export const SLACK_CREDENTIAL_TYPES = [SLACK_CREDENTIAL, SLACK_OAUTH2_CREDENTIAL] as const;
export const SLACK_API = 'https://slack.com/api';
/** Slack refuses request timestamps further off than this. */
export const MAX_SKEW_SECONDS = 300;
/** Slack's limit for a message's text is 40,000 characters; split well before. */
const MAX_TEXT = 3_500;

export interface SlackCredential {
  accessToken: string;
  baseUrl: string;
  signingSecret?: string;
}

export function slackCredential(data: JsonObject | undefined): SlackCredential {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const accessToken = text(data?.accessToken);
  if (!accessToken) throw new Error('The Slack credential has no access token');
  return { accessToken, baseUrl: (text(data?.baseUrl) || SLACK_API).replace(/\/+$/, ''), ...(text(data?.signingSecret) && { signingSecret: text(data?.signingSecret) }) };
}

/** The Slack credential type a node's credentials (or an agent channel's reference) hold: the token type or the OAuth2 one. */
export function slackRefOf(held: Record<string, { id: string; name: string }> | undefined): { ref: { id: string; name: string }; type: string } | undefined {
  for (const type of SLACK_CREDENTIAL_TYPES) {
    const ref = held?.[type] ?? held?.[type.split('.')[1]];
    if (ref) return { ref, type };
  }
  return undefined;
}

/**
 * The credential behind a saved reference (either Slack type; its fields may read `$secrets`, resolved here). An OAuth2
 * credential's bot token is renewed first when it is about to expire.
 */
export async function slackCredentialFor(ref: { id: string; name: string }): Promise<SlackCredential> {
  const type = credentials.list().find((summary) => summary.id === ref.id)?.type ?? SLACK_CREDENTIAL;
  if (!(SLACK_CREDENTIAL_TYPES as readonly string[]).includes(type)) throw new Error(`Credential "${ref.name}" is a ${type}, not a Slack credential`);
  const fresh = await freshCredentials({ slack: credentials.dataFor(ref, type) });
  return slackCredential(fresh!.slack);
}

/** Every Slack credential with a signing secret (Interactivity requests are checked against each). */
export async function slackCredentialsWithSecret(): Promise<Array<{ id: string; name: string; credential: SlackCredential }>> {
  const all = await Promise.all(
    credentials.list().map(async (summary) => {
      if (!(SLACK_CREDENTIAL_TYPES as readonly string[]).includes(summary.type)) return [];
      try {
        const credential = await slackCredentialFor(summary);
        return credential.signingSecret ? [{ id: summary.id, name: summary.name, credential }] : [];
      } catch {
        return [];
      }
    }),
  );
  return all.flat();
}

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`Slack ${method} failed: ${code}`);
    this.name = 'SlackApiError';
  }
}

/** One Web API call (POST JSON). Slack answers 200 with `ok: false` for most failures. */
export async function slackCall<T = JsonObject>(credential: SlackCredential, method: string, body: JsonObject, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${credential.baseUrl}/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${credential.accessToken}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  const data = (await response.json().catch(() => undefined)) as (JsonObject & { ok?: boolean; error?: string }) | undefined;
  if (!response.ok || !data) throw new SlackApiError(method, data?.error ?? `HTTP ${response.status}`);
  if (data.ok !== true) throw new SlackApiError(method, String(data.error ?? 'unknown_error'));
  return data as T;
}

/** Post a message (split into several when long); returns the first message's ts. */
export async function postMessage(credential: SlackCredential, message: { channel: string; text: string; threadTs?: string; blocks?: JsonObject[] }): Promise<string | undefined> {
  const parts = message.blocks ? [message.text] : split(message.text);
  let first: string | undefined;
  for (const part of parts) {
    const reply = await slackCall<{ ts?: string }>(credential, 'chat.postMessage', {
      channel: message.channel,
      text: part,
      ...(message.threadTs && { thread_ts: message.threadTs }),
      ...(message.blocks && { blocks: message.blocks }),
      unfurl_links: false,
    });
    first ??= reply.ts;
  }
  return first;
}

/**
 * Post to a slash command's or button's `response_url` (https://api.slack.com/interactivity/handling#message_responses): the
 * request's own authorization, good for five answers within 30 minutes, so no bot token (or channel membership) is needed.
 * Long text goes out as several messages.
 */
export async function postResponseUrl(url: string, message: { text: string; blocks?: JsonObject[]; response_type?: 'in_channel' | 'ephemeral'; replace_original?: boolean }, signal?: AbortSignal): Promise<void> {
  if (!/^https?:\/\//i.test(url)) throw new Error('The response_url is not an http(s) URL');
  const parts = message.blocks ? [message.text] : split(message.text);
  for (const [index, part] of parts.entries()) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      // Only the first part may replace the original message.
      body: JSON.stringify({ ...message, text: part, ...(index > 0 && { replace_original: false }) }),
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new SlackApiError('response_url', `HTTP ${response.status}`);
  }
}

export async function updateMessage(credential: SlackCredential, message: { channel: string; ts: string; text: string; blocks?: JsonObject[] }) {
  await slackCall(credential, 'chat.update', { channel: message.channel, ts: message.ts, text: message.text, ...(message.blocks && { blocks: message.blocks }) });
}

function split(text: string): string[] {
  const parts: string[] = [];
  let rest = text.trim() || '(no reply)';
  while (rest.length > MAX_TEXT) {
    const cut = Math.max(rest.lastIndexOf('\n', MAX_TEXT), MAX_TEXT / 2);
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  return [...parts, rest];
}

/** `v0=<hex>` for a body, as Slack signs it (tests and the fake server use it too). */
export function slackSignature(secret: string, timestamp: string | number, body: string): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/** Check a request's `X-Slack-Signature` and `X-Slack-Request-Timestamp` against the signing secret. */
export function verifySlackRequest(secret: string, headers: Headers, body: string, now = Date.now()): VerifyResult {
  const timestamp = headers.get('x-slack-request-timestamp') ?? '';
  const signature = headers.get('x-slack-signature') ?? '';
  if (!timestamp || !signature) return { ok: false, reason: 'Missing Slack signature headers' };
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(now / 1000 - seconds) > MAX_SKEW_SECONDS) return { ok: false, reason: 'Stale Slack request timestamp' };
  const expected = Buffer.from(slackSignature(secret, timestamp, body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'Invalid Slack signature' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Approval buttons (Block Kit)
// ---------------------------------------------------------------------------

export const APPROVE_ACTION = 'landflow_approve';
export const REJECT_ACTION = 'landflow_reject';
/** Ask a Person: opens a modal with the draft. */
export const EDIT_ACTION = 'landflow_edit';
/** The callback id of that modal. */
export const EDIT_MODAL = 'landflow_confirm_edit';

/** What a button carries back (its `value`, JSON): a workflow execution's or an agent session's tool call. */
export type ApprovalTarget =
  | { t: 'wf'; e: string; c: string }
  // `cmd` (the Slack channel id) marks a slash command's session: its messages go through response URLs, not the bot token.
  | { t: 'agent'; a: string; ch: string; s: string; c: string; th?: string; cmd?: string };

const preview = (input: unknown) => {
  const text = JSON.stringify(input ?? {}, null, 2);
  return text.length > 2_500 ? `${text.slice(0, 2_500)}…` : text;
};

/** "Approve / Reject" for one tool call. */
export function approvalBlocks(request: { title: string; tool: string; input: unknown; target: ApprovalTarget }): JsonObject[] {
  const value = JSON.stringify(request.target);
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `*${escape(request.title)}*\nThe tool \`${escape(request.tool)}\` needs your approval.` } },
    { type: 'section', text: { type: 'mrkdwn', text: `\`\`\`${escape(preview(request.input))}\`\`\`` } },
    {
      type: 'actions',
      block_id: 'landflow_approval',
      elements: [
        { type: 'button', action_id: APPROVE_ACTION, style: 'primary', text: { type: 'plain_text', text: 'Approve' }, value },
        { type: 'button', action_id: REJECT_ACTION, style: 'danger', text: { type: 'plain_text', text: 'Reject' }, value },
      ],
    },
  ];
}

/** The same message once decided: the buttons replaced by who decided what. */
export function decidedBlocks(request: { title: string; tool: string; input: unknown; approved: boolean; user?: string; note?: string }): JsonObject[] {
  const who = request.user ? ` by <@${request.user}>` : '';
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `*${escape(request.title)}*\nThe tool \`${escape(request.tool)}\`` } },
    { type: 'section', text: { type: 'mrkdwn', text: `\`\`\`${escape(preview(request.input))}\`\`\`` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${request.approved ? '✅ Approved' : '❌ Rejected'}${who}${request.note ? ` — ${escape(request.note)}` : ''}` }] },
  ];
}

/** A section block's text may not pass 3,000 characters. */
const draftText = (text: string) => (text.length > 2_800 ? `${text.slice(0, 2_800)}…` : text);

/** Ask a Person: the draft with Approve / Edit (when allowed) / Reject. */
export function confirmBlocks(request: { title: string; text: string; allowEdit: boolean; target: ApprovalTarget }): JsonObject[] {
  const value = JSON.stringify(request.target);
  const elements: JsonObject[] = [{ type: 'button', action_id: APPROVE_ACTION, style: 'primary', text: { type: 'plain_text', text: 'Approve' }, value }];
  if (request.allowEdit && request.text.length <= 3_000) elements.push({ type: 'button', action_id: EDIT_ACTION, text: { type: 'plain_text', text: 'Edit' }, value });
  elements.push({ type: 'button', action_id: REJECT_ACTION, style: 'danger', text: { type: 'plain_text', text: 'Reject' }, value });
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `*${escape(request.title)}*` } },
    { type: 'section', text: { type: 'mrkdwn', text: escape(draftText(request.text)) } },
    { type: 'actions', block_id: 'landflow_approval', elements },
  ];
}

/** The same message once answered: the buttons replaced by who decided what (the text as approved, when edited). */
export function confirmDecidedBlocks(request: { title: string; text: string; approved: boolean; edited?: boolean; user?: string; note?: string; comment?: string }): JsonObject[] {
  const who = request.user ? ` by <@${request.user}>` : '';
  const verdict = request.approved ? (request.edited ? '✅ Approved with changes' : '✅ Approved') : '❌ Rejected';
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `*${escape(request.title)}*` } },
    { type: 'section', text: { type: 'mrkdwn', text: escape(draftText(request.text)) } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${verdict}${who}${request.note ? ` — ${escape(request.note)}` : ''}${request.comment ? `: “${escape(request.comment)}”` : ''}` }] },
  ];
}

/** The modal Edit opens: the draft in a text box, and an optional comment. `meta` comes back with the submission. */
export function editModal(request: { text: string; meta: string }): JsonObject {
  return {
    type: 'modal',
    callback_id: EDIT_MODAL,
    private_metadata: request.meta,
    title: { type: 'plain_text', text: 'Edit and approve' },
    submit: { type: 'plain_text', text: 'Approve' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      { type: 'input', block_id: 'text', label: { type: 'plain_text', text: 'Text' }, element: { type: 'plain_text_input', action_id: 'text', multiline: true, initial_value: request.text.slice(0, 3_000) } },
      { type: 'input', block_id: 'comment', optional: true, label: { type: 'plain_text', text: 'Comment' }, element: { type: 'plain_text_input', action_id: 'comment', multiline: true } },
    ],
  };
}

/** Slack's three mrkdwn control characters. */
export const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A button value back as a target; undefined when it isn't one of ours. */
export function parseTarget(value: unknown): ApprovalTarget | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value) as ApprovalTarget;
    if (parsed?.t === 'wf' && typeof parsed.e === 'string' && typeof parsed.c === 'string') return parsed;
    if (parsed?.t === 'agent' && typeof parsed.a === 'string' && typeof parsed.s === 'string' && typeof parsed.c === 'string' && typeof parsed.ch === 'string') return parsed;
  } catch {
    // Not ours.
  }
  return undefined;
}

/** Background work started by a Slack request (Slack wants an answer within 3 s); tests await it. */
const tasks = singleton('slack-tasks', () => new Set<Promise<unknown>>());

export function inBackground(work: () => Promise<unknown>, onError: (error: unknown) => void) {
  const task = work().catch(onError);
  tasks.add(task);
  void task.finally(() => tasks.delete(task));
}

export async function settleSlackTasks(): Promise<void> {
  while (tasks.size) await Promise.all([...tasks]);
}
