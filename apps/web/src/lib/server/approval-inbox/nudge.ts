/**
 * The nudges of a new approval request (docs/approval-inbox.md#nudges): existing channels only, once per request, in the
 * background, never failing the run.
 *
 * - **Mail** over the host's SMTP (only when `mailConfigured()`): to every active user with `run` access on the workflow (the
 *   person's decision of 2026-11-19: everyone who may approve gets the mail) and the agent's own `approvalEmails`,
 *   deduplicated by address. Each message carries that address's Approve and Deny links (they expire with the request) and the
 *   Needs you link. Counts go into `nudged`, never an address.
 * - **Alert channels** only through a rule the person made with the event `approval`: the alert service's ticker calls
 *   `checkApprovalAlerts`; one message per request and rule; the text names the tool, agent, workflow, destination, expiry and
 *   link, never a parameter value.
 * Nothing else: no Slack app message, no default channel.
 * A judge request (C13) says which judge could not decide and why in fixed words; its mail also carries the judge's reason (cut),
 * its alert never does: the reason is a model's words and may quote the item.
 */
import { nudgeSubject } from '../../shared/approval-inbox';
import { FALLBACK_WORDS, isFallbackReason, judgeNudgeSubject, type JudgeEvidence } from '../../shared/judge';
import type { AlertRule } from '../../shared/alerts';
import { opensTickets } from '../../shared/alerts';
import type { TicketRequest } from '../alerts/tickets';
import { alertStore } from '../alerts/store';
import { customNotice, type AlertNotice } from '../alerts/message';
import { watches } from '../alerts/rules';
import { mailConfigured, sendMail } from '../auth/mail';
import { listUsers } from '../auth/users';
import { publicUrl } from '../config';
import { database } from '../db';
import { canResource } from '../projects/access';
import { store } from '../store';
import { logger } from '../telemetry';
import { expiryClock, requestRow, recordNudge, type InboxRow } from './store';
import { maskParams } from '../../shared/approval-inbox';
import { sweepTickets } from './tickets';

const pending = new Set<Promise<void>>();

/** Resolves when every nudge started so far finished (tests; a shutdown). */
export async function flushNudges(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}

/** The Needs you link of a request. */
export const needsYouLink = (id: string) => `${publicUrl()}/?approval=${encodeURIComponent(id)}`;

/** Start the mail nudge of each new request in the background (never throws, never awaited by the run). */
export function nudgeNew(rows: InboxRow[]): void {
  for (const row of rows) {
    const work: Promise<void> = mailNudge(row)
      .catch((error: Error) => logger.warn('approval mail nudge skipped', { 'landflow.approval.request': row.id, error: error.message }))
      .finally(() => pending.delete(work));
    pending.add(work);
  }
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Every active user who may approve this request, by address, plus the agent's approval emails, deduplicated. */
export async function recipientsOf(row: Pick<InboxRow, 'workflow_id' | 'agent_id'>): Promise<string[]> {
  const seen = new Map<string, string>();
  for (const user of listUsers()) {
    if (user.disabledAt || !user.email || !canResource(user, 'workflow', row.workflow_id, 'run')) continue;
    if (!seen.has(user.email.toLowerCase())) seen.set(user.email.toLowerCase(), user.email);
  }
  const { parseAddresses } = await import('../approval-email');
  const { agentStore } = await import('../agents/store');
  const agent = agentStore.get(row.agent_id);
  for (const address of parseAddresses(agent?.published?.config.settings.approvalEmails ?? agent?.settings?.approvalEmails)) {
    if (!seen.has(address.toLowerCase())) seen.set(address.toLowerCase(), address);
  }
  return [...seen.values()];
}

async function mailNudge(row: InboxRow): Promise<void> {
  if (!mailConfigured()) return;
  const { approvalLinks } = await import('../approval-email');
  const to = await recipientsOf(row);
  if (!to.length) return;
  const params = maskParams(JSON.parse(row.params) as Record<string, unknown>);
  const shown = JSON.stringify(params, null, 2);
  const preview = shown.length > 2_000 ? `${shown.slice(0, 2_000)}…` : shown;
  const version = (v: string | number | null) => (v === null ? '' : v === 'draft' ? ' (draft)' : ` v${v}`);
  const judge = row.kind === 'judge';
  const evidence = judge ? (JSON.parse(row.evidence ?? 'null') as JudgeEvidence | null) : null;
  const why = evidence && isFallbackReason(evidence.fallbackReason) ? FALLBACK_WORDS[evidence.fallbackReason] : 'it could not decide';
  const subject = judge ? judgeNudgeSubject(row.tool, row.workflow_name) : nudgeSubject(row.tool, row.workflow_name);
  const reason = evidence?.reason ? (evidence.reason.length > 500 ? `${evidence.reason.slice(0, 500)}…` : evidence.reason) : '';
  const expires = row.expires_at;
  const needsYou = needsYouLink(row.id);
  let sent = 0;
  for (const address of to) {
    const links = approvalLinks({ t: 'wf', e: row.execution_id, c: row.call_id }, address, Date.now(), Date.parse(row.expires_at));
    const lines = [
      judge ? `A ${row.trigger_word} run waits for your decision: the AI Judge “${row.tool}” could not decide (${why}).` : `A ${row.trigger_word} run waits for your approval to run “${row.tool}”.`,
      ...(judge ? [] : [`Agent: ${row.agent_name}${version(row.agent_version)}`]),
      `Workflow: ${row.workflow_name}${version(row.workflow_version === null ? null : String(row.workflow_version))}`,
      ...(row.destination ? [`Goes to: ${row.destination}`] : []),
      ...(reason ? ['', `The judge said: ${reason}`] : []),
      '',
      preview,
      '',
      `Approve: ${links.approve}`,
      `Deny:    ${links.reject}`,
      `Open in Needs you: ${needsYou}`,
      '',
      judge ? `The links work once. The request expires ${expiryClock(expires)}; if nobody decides by then it is denied.` : `The links work once. The request expires ${expiryClock(expires)}; if nobody decides by then “${row.tool}” does not run.`,
    ];
    const button = (label: string, href: string, color: string) => `<a href="${escapeHtml(href)}" style="display:inline-block;padding:9px 18px;margin-right:8px;border-radius:8px;background:${color};color:#fff;text-decoration:none;font-weight:600">${label}</a>`;
    const html =
      `<p>${judge ? `A ${escapeHtml(row.trigger_word)} run waits for your decision: the AI Judge <code>${escapeHtml(row.tool)}</code> could not decide (${escapeHtml(why)}).` : `A ${escapeHtml(row.trigger_word)} run waits for your approval to run <code>${escapeHtml(row.tool)}</code>.<br>Agent: <strong>${escapeHtml(row.agent_name)}${escapeHtml(version(row.agent_version))}</strong>`}<br>Workflow: <strong>${escapeHtml(row.workflow_name)}${escapeHtml(version(row.workflow_version === null ? null : String(row.workflow_version)))}</strong></p>` +
      (row.destination ? `<p>Goes to: ${escapeHtml(row.destination)}</p>` : '') +
      (reason ? `<p>The judge said: ${escapeHtml(reason)}</p>` : '') +
      `<pre style="background:#f4f4f5;padding:10px;border-radius:8px;white-space:pre-wrap">${escapeHtml(preview)}</pre>` +
      `<p>${button('Approve', links.approve, '#16a34a')}${button('Deny', links.reject, '#dc2626')}</p>` +
      `<p><a href="${escapeHtml(needsYou)}">Open in Needs you</a></p>` +
      `<p style="color:#71717a;font-size:12px">The links work once. The request expires ${escapeHtml(expiryClock(expires))}; if nobody decides by then ${judge ? 'it is denied' : `“${escapeHtml(row.tool)}” does not run`}.</p>`;
    try {
      await sendMail({ to: address, subject, text: lines.join('\n'), html });
      sent++;
    } catch (error) {
      logger.warn('approval mail not sent', { 'landflow.approval.request': row.id, error: (error as Error).message });
    }
  }
  if (sent) await recordNudge(row.id, { email: sent, channels: 0 });
}

const ALERT_PREFIX = 'approval:';

/** The alert a rule sends for a request: the tool, agent, workflow, destination, expiry and the link. Never a parameter value. */
export function approvalNotice(rule: Pick<AlertRule, 'id' | 'name'>, row: InboxRow): AlertNotice {
  const at = (v: string | number | null) => (v === null ? '' : v === 'draft' ? ' (draft)' : ` v${v}`);
  if (row.kind === 'judge') {
    const code = (JSON.parse(row.evidence ?? 'null') as JudgeEvidence | null)?.fallbackReason;
    return customNotice({
      event: 'approval',
      rule,
      about: { id: row.workflow_id, name: row.workflow_name },
      subject: judgeNudgeSubject(row.tool, row.workflow_name),
      // Fixed words only: the judge's reason and the item are never in an alert.
      facts: [
        { label: 'AI Judge', value: row.tool },
        { label: 'Why it asks', value: isFallbackReason(code) ? FALLBACK_WORDS[code] : 'it could not decide' },
        { label: 'Workflow', value: `${row.workflow_name}${at(row.workflow_version)}` },
        { label: 'Expires', value: expiryClock(row.expires_at) },
      ],
      link: needsYouLink(row.id),
    });
  }
  return customNotice({
    event: 'approval',
    rule,
    about: { id: row.workflow_id, name: row.workflow_name },
    subject: nudgeSubject(row.tool, row.workflow_name),
    facts: [
      { label: 'Tool', value: row.tool },
      { label: 'Agent', value: `${row.agent_name}${at(row.agent_version)}` },
      { label: 'Workflow', value: `${row.workflow_name}${at(row.workflow_version)}` },
      ...(row.destination ? [{ label: 'Goes to', value: row.destination }] : []),
      { label: 'Expires', value: expiryClock(row.expires_at) },
    ],
    link: needsYouLink(row.id),
  });
}

/**
 * What a ticket says of a request (C12): the alert's subject and fixed facts and the Needs you link, built from `approvalNotice`
 * so a parameter, a judge's evidence or reason, or an item's text can never reach a ticket, and never the emailed Approve and
 * Deny links (this module's mail holds those, and does not pass them on).
 */
export function ticketRequestOf(row: InboxRow): TicketRequest {
  const notice = approvalNotice({ id: 'ticket', name: 'ticket' }, row);
  return {
    requestId: row.id,
    kind: row.kind === 'judge' ? 'judge' : 'tool',
    subject: notice.custom?.subject ?? nudgeSubject(row.tool, row.workflow_name),
    facts: (notice.custom?.facts ?? []).filter((fact) => !fact.url).map(({ label, value }) => ({ label, value })),
    link: needsYouLink(row.id),
    expiresAt: row.expires_at,
  };
}

/**
 * The alert service's ticker: for each waiting request and each enabled rule that has the event `approval` and watches the run,
 * send once (the marker is the `waiting` alert's table, keyed `approval:<request id>`).
 */
export async function checkApprovalAlerts(now: number, send: (rule: AlertRule, notice: AlertNotice) => Promise<void>): Promise<void> {
  const rows = database().all<InboxRow>("SELECT * FROM approval_inbox WHERE status = 'waiting'");
  // A request that is no longer waiting forgets its markers.
  for (const marker of database().all<{ rule_id: string; execution_id: string }>('SELECT rule_id, execution_id FROM alert_waiting_sent WHERE execution_id LIKE ?', `${ALERT_PREFIX}%`)) {
    if (!rows.some((row) => `${ALERT_PREFIX}${row.id}` === marker.execution_id)) database().delete('alert_waiting_sent', { rule_id: marker.rule_id, execution_id: marker.execution_id });
  }
  const rules = alertStore.rules().filter((rule) => (rule.kind ?? 'runs') === 'runs' && rule.enabled && rule.events.includes('approval') && rule.channelIds.length);
  // C12: a ticket channel gets a ticket (its own retries and its close), not the one-shot alert; the plain channels keep today's path.
  const channelById = new Map(alertStore.channels().map((channel) => [channel.id, channel]));
  await sweepTickets(now, rules, channelById, ticketRequestOf);
  const plain = rules.map((rule) => ({ ...rule, channelIds: rule.channelIds.filter((id) => !channelById.has(id) || !opensTickets(channelById.get(id)!)) })).filter((rule) => rule.channelIds.length);
  if (!plain.length) return;
  for (const row of rows) {
    if (Date.parse(row.expires_at) <= now) continue;
    const record = await store.loadExecution(row.execution_id);
    if (!record) continue;
    let channels = 0;
    for (const rule of plain) {
      if (!watches(rule, record, store.getWorkflow(row.workflow_id))) continue;
      if (!alertStore.markWaitingSent(rule.id, `${ALERT_PREFIX}${row.id}`)) continue;
      await send(rule, approvalNotice(rule, row));
      channels += rule.channelIds.length;
    }
    if (channels && requestRow(row.id)) await recordNudge(row.id, { email: 0, channels });
  }
}
