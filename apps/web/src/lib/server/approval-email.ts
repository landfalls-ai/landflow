/**
 * Approvals by email: tool approvals of agents and of AI Agent nodes reach people as an email with an Approve and a
 * Reject link, sent over the host's SMTP (lib/server/auth/mail.ts, LANDFLOW_SMTP_*).
 *
 * A link is `<LANDFLOW_PUBLIC_URL>/api/approvals/email/<token>` with token = `<payload>.<signature>`: base64url JSON
 * `{ g: group, t: target, d: approve|reject, m: address, x: expiry }` signed with HMAC-SHA256 under a key derived from the
 * vault's key, so nothing needs storing to send one. The two links of a tool call share a group, and the group is
 * spent by whoever uses a link first (`approval_email_used`, a primary key insert: atomic across processes), so a link works
 * once and the other one then does not. Opening a link only shows a confirmation page (mail scanners fetch links);
 * the page's button POSTs, and that decides. A link is bound to the address it was sent to and recorded as the decider
 * (`email:<address>`).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { approvalSubject, type Agent, type PendingCall } from '../shared/agents';
import { ApprovalError, decideApproval, pendingApproval } from './approvals';
import { decide, DecisionError } from './agents/runtime';
import { agentStore } from './agents/store';
import { mailConfigured, sendMail } from './auth/mail';
import { credentials } from './credentials/vault';
import { database } from './db';
import { store } from './store';
import { logger } from './telemetry';

export type EmailApprovalTarget = { t: 'wf'; e: string; c: string } | { t: 'agent'; a: string; s: string; c: string };

export interface LinkPayload {
  /** Link group: the approve and reject link of one tool call and recipient. */
  g: string;
  t: EmailApprovalTarget;
  d: 'approve' | 'reject';
  /** The address the link was sent to. */
  m: string;
  /** Expiry, ms since the epoch. */
  x: number;
}

export const DEFAULT_TTL_HOURS = 24;
const ttlMs = () => Math.max(1, Number(process.env.LANDFLOW_APPROVAL_EMAIL_TTL_HOURS) || DEFAULT_TTL_HOURS) * 3_600_000;
const publicUrl = () => (process.env.LANDFLOW_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/+$/, '');
const key = () => credentials.deriveKey('approval.email');
const b64url = (buffer: Buffer) => buffer.toString('base64url');

export const parseAddresses = (value: unknown): string[] => {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[,;\s]+/);
  const seen = new Set<string>();
  for (const entry of raw) {
    const address = String(entry).trim();
    if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) seen.add(address);
  }
  return [...seen];
};

export function signLink(payload: LinkPayload): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  return `${body}.${b64url(createHmac('sha256', key()).update(body).digest())}`;
}

/** The payload of a token this host signed; throws a LinkError (410 once expired). */
export function verifyLink(token: string, now = Date.now()): LinkPayload {
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra !== undefined) throw new LinkError('This approval link is not valid', 400);
  const expected = createHmac('sha256', key()).update(body).digest();
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new LinkError('This approval link is not valid', 400);
  let payload: LinkPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as LinkPayload;
  } catch {
    throw new LinkError('This approval link is not valid', 400);
  }
  const target = payload?.t;
  const wellFormed =
    typeof payload?.g === 'string' && typeof payload.m === 'string' && typeof payload.x === 'number' && (payload.d === 'approve' || payload.d === 'reject') &&
    ((target?.t === 'wf' && typeof target.e === 'string' && typeof target.c === 'string') ||
      (target?.t === 'agent' && typeof target.a === 'string' && typeof target.s === 'string' && typeof target.c === 'string'));
  if (!wellFormed) throw new LinkError('This approval link is not valid', 400);
  if (payload.x < now) throw new LinkError('This approval link has expired', 410);
  return payload;
}

export class LinkError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The approve and reject URLs of one tool call for one address. */
export function approvalLinks(target: EmailApprovalTarget, email: string, now = Date.now()): { approve: string; reject: string; expiresAt: string } {
  const g = randomBytes(12).toString('base64url');
  const x = now + ttlMs();
  const url = (d: 'approve' | 'reject') => `${publicUrl()}/api/approvals/email/${signLink({ g, t: target, d, m: email, x })}`;
  return { approve: url('approve'), reject: url('reject'), expiresAt: new Date(x).toISOString() };
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const preview = (input: unknown) => {
  const text = JSON.stringify(input ?? {}, null, 2);
  return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text;
};

export interface ApprovalEmailCall {
  tool: string;
  input: unknown;
  target: EmailApprovalTarget;
  /** Ask a Person: the email asks about this draft instead of a tool call. */
  confirm?: { text: string };
}

/** Email each address one message per waiting tool call, with its two links. Returns the addresses it reached. */
export async function sendApprovalEmails(options: { to: string[]; title: string; calls: ApprovalEmailCall[]; note?: string }): Promise<string[]> {
  const sent: string[] = [];
  for (const to of options.to) {
    for (const call of options.calls) {
      const links = approvalLinks(call.target, to);
      const subject = call.confirm ? options.title : `${options.title}: approve ${call.tool}?`;
      const body = call.confirm ? call.confirm.text.slice(0, 20_000) : preview(call.input);
      const text = [
        options.title,
        call.confirm ? 'Please review this and answer.' : `The tool "${call.tool}" needs your approval.`,
        '',
        body,
        '',
        `Approve: ${links.approve}`,
        `Reject:  ${links.reject}`,
        '',
        `The links work once and expire ${links.expiresAt}.${options.note ? `\n${options.note}` : ''}`,
      ].join('\n');
      const button = (label: string, href: string, color: string) =>
        `<a href="${escapeHtml(href)}" style="display:inline-block;padding:9px 18px;margin-right:8px;border-radius:8px;background:${color};color:#fff;text-decoration:none;font-weight:600">${label}</a>`;
      const html =
        `<p><strong>${escapeHtml(options.title)}</strong><br>${call.confirm ? 'Please review this and answer.' : `The tool <code>${escapeHtml(call.tool)}</code> needs your approval.`}</p>` +
        `<pre style="background:#f4f4f5;padding:10px;border-radius:8px;white-space:pre-wrap">${escapeHtml(body)}</pre>` +
        `<p>${button('Approve', links.approve, '#16a34a')}${button('Reject', links.reject, '#dc2626')}</p>` +
        `<p style="color:#71717a;font-size:12px">The links work once and expire ${escapeHtml(links.expiresAt)}.${options.note ? ` ${escapeHtml(options.note)}` : ''}</p>`;
      await sendMail({ to, subject, text, html });
    }
    sent.push(to);
  }
  return sent;
}

/** An agent run stopped for approvals: email the configured addresses a pair of links per undecided call (best effort). */
export async function notifyApprovalEmails(agent: Agent, session: { id: string; pending?: { calls: PendingCall[] } }, recipients: string[] | undefined) {
  const to = parseAddresses(recipients);
  if (!to.length || !session.pending) return;
  if (!mailConfigured()) {
    logger.warn('approval emails are set for an agent but the host has no SMTP (LANDFLOW_SMTP_HOST)', { 'gen_ai.agent.id': agent.id });
    return;
  }
  const calls = session.pending.calls.filter((c) => !c.decision).map((c): ApprovalEmailCall => ({ ...approvalSubject(c), target: { t: 'agent', a: agent.id, s: session.id, c: c.callId } }));
  if (!calls.length) return;
  try {
    await sendApprovalEmails({ to, title: `${agent.published?.config.name ?? agent.name} wants to run a tool`, calls });
  } catch (error) {
    logger.warn('could not send approval emails', { 'gen_ai.agent.id': agent.id, error: (error as Error).message });
  }
}

// ---------------------------------------------------------------------------
// Using a link
// ---------------------------------------------------------------------------

export interface LinkView {
  payload: LinkPayload;
  title: string;
  tool: string;
  input: unknown;
  /** Ask a Person: the request's title and draft. */
  confirm?: { title: string; text: string };
  /** Set when the link can no longer decide: spent, already decided, run finished. */
  closed?: string;
}

const isUsed = (group: string) => Boolean(database().get('SELECT group_id FROM approval_email_used WHERE group_id = ?', group));

/** What a link would decide, for its confirmation page. */
export function describeLink(token: string): LinkView {
  const payload = verifyLink(token);
  const target = payload.t;
  let view: Omit<LinkView, 'payload'>;
  if (target.t === 'wf') {
    const record = store.getExecution(target.e);
    const approval = pendingApproval(record);
    const call = approval?.calls.find((c) => c.id === target.c);
    view = { title: approval ? `${approval.nodeName} (${record?.workflowName ?? 'workflow'})` : 'A workflow', tool: call?.tool ?? 'a tool', input: call?.input ?? {}, ...(approval?.confirm && { confirm: { title: approval.confirm.title, text: String((call?.input as { text?: unknown } | undefined)?.text ?? approval.confirm.text) } }) };
    if (!call || approval?.decisions?.[target.c]) view.closed = 'This tool call is no longer waiting for approval.';
  } else {
    const agent = agentStore.get(target.a);
    const call = agentStore.getSession(target.s)?.pending?.calls.find((c) => c.callId === target.c);
    view = { title: agent?.published?.config.name ?? agent?.name ?? 'An agent', tool: call?.tool ?? 'a tool', input: call?.input ?? {} };
    if (!agent || !call || call.decision) view.closed = 'This tool call is no longer waiting for approval.';
  }
  if (!view.closed && isUsed(payload.g)) view.closed = 'This link was already used.';
  return { payload, ...view };
}

export interface LinkOutcome {
  approved: boolean;
  tool: string;
  title: string;
  /** Ask a Person's request (it has no tool). */
  confirm?: boolean;
}

/** Decide with a link: spends its group first (so a second use fails), then records the decision; a failed decision frees the link. */
export async function useLink(token: string): Promise<LinkOutcome> {
  const view = describeLink(token);
  if (view.closed) throw new LinkError(view.closed, 409);
  const { payload } = view;
  const approved = payload.d === 'approve';
  const by = `email:${payload.m}`;
  const claimed = database().insertNew('approval_email_used', {
    group_id: payload.g,
    decision: payload.d,
    email: payload.m,
    used_at: new Date().toISOString(),
    expires_at: new Date(payload.x).toISOString(),
  });
  if (!claimed) throw new LinkError('This link was already used.', 409);
  try {
    const target = payload.t;
    if (target.t === 'wf') {
      await decideApproval(target.e, target.c, approved, { by });
    } else {
      const agent = agentStore.get(target.a);
      if (!agent) throw new LinkError('The agent no longer exists', 404);
      const outcome = await decide(agent, target.s, target.c, approved, { by });
      if (outcome.status === 'resumed') await deliverToChannel(agent, outcome);
    }
  } catch (error) {
    // Nothing was decided: the link stays usable (until it expires).
    database().delete('approval_email_used', { group_id: payload.g });
    if (error instanceof ApprovalError || error instanceof DecisionError) throw new LinkError(error.message, error.status);
    throw error;
  }
  // Old rows go with the next use.
  database().deleteBefore('approval_email_used', 'expires_at', new Date().toISOString());
  logger.info('approval decided by email link', { 'landflow.approval.approved': approved, 'landflow.approval.by': by });
  return { approved, tool: view.tool, title: view.confirm?.title ?? view.title, ...(view.confirm && { confirm: true }) };
}

/** After an email decision resumed a channel session, the answer belongs in that chat (Slack thread, Teams conversation). */
async function deliverToChannel(agent: Agent, outcome: Awaited<ReturnType<typeof decide>> & { status: 'resumed' }) {
  const { session } = outcome;
  try {
    if (session.source === 'slack') {
      const { deliverResumedSlack } = await import('./slack/handlers');
      await deliverResumedSlack(agent, outcome);
    } else if (session.source === 'teams') {
      const { deliverResumedTeams } = await import('./teams/handlers');
      await deliverResumedTeams(agent, outcome);
    }
  } catch (error) {
    logger.warn('could not deliver the answer after an email approval', { 'gen_ai.agent.id': agent.id, error: (error as Error).message });
  }
}

// ---------------------------------------------------------------------------
// The confirmation page
// ---------------------------------------------------------------------------

const PAGE = (body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">` +
  `<title>Landflow approval</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:560px;margin:10vh auto;padding:0 20px;color:#18181b}` +
  `pre{background:#f4f4f5;padding:12px;border-radius:8px;white-space:pre-wrap;overflow:auto}button{font:inherit;font-weight:600;padding:9px 20px;border:0;border-radius:8px;color:#fff;cursor:pointer}` +
  `.approve{background:#16a34a}.reject{background:#dc2626}.muted{color:#71717a}</style></head><body>${body}</body></html>`;

const html = (body: string, status = 200) => new Response(PAGE(body), { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });

/** GET: what the link would do, with a button. Never decides. */
export function confirmationPage(token: string): Response {
  try {
    const view = describeLink(token);
    if (view.closed) return html(`<h2>Nothing to decide</h2><p>${escapeHtml(view.closed)}</p>`, 409);
    const approve = view.payload.d === 'approve';
    return html(
      (view.confirm
        ? `<h2>${approve ? 'Approve' : 'Reject'} this?</h2><p><strong>${escapeHtml(view.confirm.title)}</strong> (${escapeHtml(view.title)}) asks for your answer.</p><pre>${escapeHtml(view.confirm.text.slice(0, 20_000))}</pre>`
        : `<h2>${approve ? 'Approve' : 'Reject'} this tool call?</h2><p><strong>${escapeHtml(view.title)}</strong> wants to run <code>${escapeHtml(view.tool)}</code>.</p><pre>${escapeHtml(preview(view.input))}</pre>`) +
        `<form method="post"><button class="${approve ? 'approve' : 'reject'}" type="submit">${approve ? 'Approve' : 'Reject'}</button></form>` +
        `<p class="muted">Sent to ${escapeHtml(view.payload.m)}. This link works once.</p>`,
    );
  } catch (error) {
    if (error instanceof LinkError) return html(`<h2>Link not usable</h2><p>${escapeHtml(error.message)}</p>`, error.status);
    throw error;
  }
}

/** POST: decide, and say what happened. */
export async function decisionPage(token: string): Promise<Response> {
  try {
    const outcome = await useLink(token);
    return html(`<h2>${outcome.approved ? 'Approved' : 'Rejected'}</h2><p>${outcome.confirm ? `<strong>${escapeHtml(outcome.title)}</strong>` : `<code>${escapeHtml(outcome.tool)}</code>`} was ${outcome.approved ? 'approved' : 'rejected'}. You can close this page.</p>`);
  } catch (error) {
    if (error instanceof LinkError) return html(`<h2>Link not usable</h2><p>${escapeHtml(error.message)}</p>`, error.status);
    throw error;
  }
}
