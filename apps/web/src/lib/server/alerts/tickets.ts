/**
 * The outside calls of a ticket channel (C12): open a ticket for an approval request, add the decision to it, and the
 * channel's Test. A ServiceNow channel uses the Table API (`POST /api/now/table/<table>`, `PATCH …/<sys_id>`) with a
 * Basic or Bearer credential from the vault; a webhook channel with "Opens tickets" POSTs signed `approval.requested`
 * and `approval.settled` events and reads `{ ticket: { id, url? } }` from the answer. No state is kept here: the inbox
 * side (which request, which retry) calls these. A ticket never carries a parameter value, the judge's input, or the
 * emailed Approve/Deny links: the request holds only the subject, the facts and the Needs you link, and nothing a
 * ticket system says decides anything. Every call goes through `safeFetch`; reasons are redacted.
 */
import { credentials } from '../credentials/vault';
import { redactText } from '../secrets/redact';
import { channelConfigWithSecrets, readJson, refusal, request, signature, type SendableChannel } from './http';
import { publicUrl } from './message';
import { hasSecretReference } from '@landflow/engine';
import { DEFAULT_TICKET_TABLE, serviceNowOrigin, TICKET_CREDENTIAL_TYPES } from './store';

/** What an approval request says to a ticket system: no parameters, no emailed links. */
export interface TicketRequest {
  requestId: string;
  kind: 'tool' | 'judge';
  subject: string;
  facts: Array<{ label: string; value: string }>;
  /** The Needs you link, which asks for a sign-in. */
  link: string;
  expiresAt: string;
}

/** Where a ticket went, as kept by Landflow. `key` is what the system needs to find it again (ServiceNow's sys_id). */
export interface TicketRef {
  system: 'servicenow' | 'webhook';
  id: string;
  url?: string;
  key: string;
}

export type TicketStatus = 'approved' | 'denied' | 'expired' | 'cancelled';

export interface TicketClose {
  requestId: string;
  status: TicketStatus;
  /** The settled line, such as "Approved by Dana Lee in Needs you · 14:05". */
  line: string;
  /** The channel's Test: a note only, no state change. */
  test?: boolean;
}

const MAX_ID = 100;
const MAX_URL = 2_000;
const MAX_SHORT = 160;
const MAX_DESCRIPTION = 4_000;
const TEST_LINE = 'Test from Landflow: the channel works.';

/** A ticket id as shown: printable characters only (no control or format characters), trimmed, at most 100. */
const cleanId = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? clip(String(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim(), MAX_ID) : '');

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** A ticket link is kept and shown only when it is http(s) and not absurdly long (D7). */
function safeLink(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_URL) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

const description = (ticket: TicketRequest) => clip([...ticket.facts.map((fact) => `${fact.label}: ${fact.value}`), `Expires: ${ticket.expiresAt}`, `Decide in Landflow: ${ticket.link}`].join('\n'), MAX_DESCRIPTION);

async function serviceNowAuth(channel: SendableChannel): Promise<string> {
  const id = channel.config.credentialId ?? '';
  const type = credentials.definition(id)?.type;
  if (!type || !(TICKET_CREDENTIAL_TYPES as readonly string[]).includes(type)) throw new Error('The ServiceNow channel needs a Basic Auth or Bearer Auth credential');
  const data = await credentials.dataWithSecrets({ id, name: `of channel "${channel.name}"` }, type);
  if (type === 'core.httpBearerAuth') return `Bearer ${String(data.token ?? '')}`;
  return `Basic ${Buffer.from(`${String(data.user ?? '')}:${String(data.password ?? '')}`).toString('base64')}`;
}

/** One Table API call; `$secrets` are resolved once here. Answers the record the system returned and the instance's origin. */
async function serviceNow(channel: SendableChannel, method: 'POST' | 'PATCH', path: string, body: Record<string, unknown>): Promise<{ result: Record<string, unknown>; origin: string }> {
  const config = await channelConfigWithSecrets(channel);
  // A literal URL was checked when the channel was saved; one that came from a secret is checked now.
  const origin = hasSecretReference(channel.config.url) ? serviceNowOrigin(config.url ?? '') : (config.url ?? '').replace(/\/+$/, '');
  const headers = { authorization: await serviceNowAuth(channel), accept: 'application/json' };
  const response = await request(method, `${origin}/api/now/table/${path}`, JSON.stringify(body), headers, 'ServiceNow');
  if (!response.ok) throw await refusal(response, 'ServiceNow');
  const answer = await readJson<{ result?: Record<string, unknown> }>(response);
  return { result: answer.result ?? {}, origin };
}

const tableOf = (channel: SendableChannel) => channel.config.table || DEFAULT_TICKET_TABLE;

async function openServiceNow(channel: SendableChannel, ticket: TicketRequest): Promise<TicketRef> {
  const table = tableOf(channel);
  const { result, origin } = await serviceNow(channel, 'POST', table, {
    short_description: clip(ticket.subject, MAX_SHORT),
    description: description(ticket),
    correlation_id: ticket.requestId,
    correlation_display: 'Landflow',
  });
  const key = typeof result.sys_id === 'string' ? result.sys_id : '';
  if (!key || !/^[0-9a-zA-Z]+$/.test(key)) throw new Error('ServiceNow did not answer with the new record’s sys_id');
  const id = cleanId(result.number) || cleanId(key);
  const url = safeLink(`${origin}/nav_to.do?uri=${table}.do?sys_id=${key}`);
  return { system: 'servicenow', id, key, ...(url && { url }) };
}

async function closeServiceNow(channel: SendableChannel, ticket: TicketRef, close: TicketClose): Promise<void> {
  const states: Record<TicketStatus, string | undefined> = { approved: channel.config.approvedState, denied: channel.config.deniedState, expired: channel.config.expiredState, cancelled: channel.config.cancelledState };
  const state = close.test ? undefined : states[close.status];
  await serviceNow(channel, 'PATCH', `${tableOf(channel)}/${encodeURIComponent(ticket.key)}`, { work_notes: close.line, ...(state && { state }) });
}

/** A signed JSON POST to the channel's URL, as alerts are (X-Landflow-Event, -Timestamp, -Signature). */
async function signedPost(channel: SendableChannel, event: string, payload: Record<string, unknown>): Promise<Response> {
  const config = await channelConfigWithSecrets(channel);
  if (!config.url) throw new Error('No webhook URL');
  const body = JSON.stringify({ event, ...payload });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = { 'x-landflow-event': event, 'x-landflow-timestamp': timestamp };
  if (config.secret) headers['x-landflow-signature'] = signature(config.secret, timestamp, body);
  const response = await request('POST', config.url, body, headers, 'The webhook');
  if (!response.ok) throw await refusal(response, 'The webhook');
  return response;
}

async function openWebhook(channel: SendableChannel, ticket: TicketRequest, test: boolean): Promise<TicketRef> {
  // Built by name, never spread: only these fields can leave, whatever else the request object carries.
  const payload = { id: ticket.requestId, kind: ticket.kind, subject: ticket.subject, facts: ticket.facts.map(({ label, value }) => ({ label, value })), link: ticket.link, expiresAt: ticket.expiresAt };
  const response = await signedPost(channel, 'approval.requested', { ...(test && { test: true }), request: payload });
  const answer = await readJson<{ ticket?: { id?: unknown; url?: unknown } }>(response);
  const id = cleanId(answer.ticket?.id);
  if (!id) throw new Error('The webhook did not answer with a ticket: it must answer { "ticket": { "id": "…", "url": "…" } }');
  const url = safeLink(answer.ticket?.url);
  return { system: 'webhook', id, key: id, ...(url && { url }) };
}

/** Open a ticket for `request` in a ticket channel. Rejects with a redacted reason when the system refuses or is down. */
export async function openTicket(channel: SendableChannel, ticket: TicketRequest, test = false): Promise<TicketRef> {
  try {
    return channel.kind === 'servicenow' ? await openServiceNow(channel, ticket) : await openWebhook(channel, ticket, test);
  } catch (error) {
    throw new Error(redactText((error as Error).message));
  }
}

/** Tell the ticket system how the request settled: a work note (and the mapped state) in ServiceNow, `approval.settled` on a webhook. */
export async function closeTicket(channel: SendableChannel, ticket: TicketRef, close: TicketClose): Promise<void> {
  try {
    if (channel.kind === 'servicenow') return await closeServiceNow(channel, ticket, close);
    await signedPost(channel, 'approval.settled', { ...(close.test && { test: true }), request: { id: close.requestId, status: close.status, line: close.line }, ticket: { id: ticket.id } });
  } catch (error) {
    throw new Error(redactText((error as Error).message));
  }
}

/** The channel's Test: open a ticket marked as a test, then add a note; answers what it did. */
export async function testTicketChannel(channel: SendableChannel): Promise<string> {
  const soon = new Date(Date.now() + 60 * 60_000).toISOString();
  const ticket = await openTicket(
    channel,
    { requestId: `test_${Date.now()}`, kind: 'tool', subject: 'Test from Landflow: approval ticket channel', facts: [{ label: 'Note', value: 'A test of this channel. Nothing waits for approval.' }], link: `${publicUrl()}/settings#alerts`, expiresAt: soon },
    true,
  );
  await closeTicket(channel, ticket, { requestId: 'test', status: 'cancelled', line: TEST_LINE, test: true });
  return `Opened ${ticket.id} and added a note`;
}
