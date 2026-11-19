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
 */
import { nudgeSubject } from '../../shared/approval-inbox';
import type { AlertRule } from '../../shared/alerts';
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
  const subject = nudgeSubject(row.tool, row.workflow_name);
  const expires = row.expires_at;
  const needsYou = needsYouLink(row.id);
  let sent = 0;
  for (const address of to) {
    const links = approvalLinks({ t: 'wf', e: row.execution_id, c: row.call_id }, address, Date.now(), Date.parse(row.expires_at));
    const lines = [
      `A ${row.trigger_word} run waits for your approval to run “${row.tool}”.`,
      `Agent: ${row.agent_name}${version(row.agent_version)}`,
      `Workflow: ${row.workflow_name}${version(row.workflow_version === null ? null : String(row.workflow_version))}`,
      ...(row.destination ? [`Goes to: ${row.destination}`] : []),
      '',
      preview,
      '',
      `Approve: ${links.approve}`,
      `Deny:    ${links.reject}`,
      `Open in Needs you: ${needsYou}`,
      '',
      `The links work once. The request expires ${expiryClock(expires)}; if nobody decides by then “${row.tool}” does not run.`,
    ];
    const button = (label: string, href: string, color: string) => `<a href="${escapeHtml(href)}" style="display:inline-block;padding:9px 18px;margin-right:8px;border-radius:8px;background:${color};color:#fff;text-decoration:none;font-weight:600">${label}</a>`;
    const html =
      `<p>A ${escapeHtml(row.trigger_word)} run waits for your approval to run <code>${escapeHtml(row.tool)}</code>.<br>Agent: <strong>${escapeHtml(row.agent_name)}${escapeHtml(version(row.agent_version))}</strong><br>Workflow: <strong>${escapeHtml(row.workflow_name)}${escapeHtml(version(row.workflow_version === null ? null : String(row.workflow_version)))}</strong></p>` +
      (row.destination ? `<p>Goes to: ${escapeHtml(row.destination)}</p>` : '') +
      `<pre style="background:#f4f4f5;padding:10px;border-radius:8px;white-space:pre-wrap">${escapeHtml(preview)}</pre>` +
      `<p>${button('Approve', links.approve, '#16a34a')}${button('Deny', links.reject, '#dc2626')}</p>` +
      `<p><a href="${escapeHtml(needsYou)}">Open in Needs you</a></p>` +
      `<p style="color:#71717a;font-size:12px">The links work once. The request expires ${escapeHtml(expiryClock(expires))}; if nobody decides by then “${escapeHtml(row.tool)}” does not run.</p>`;
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
  if (!rules.length) return;
  for (const row of rows) {
    if (Date.parse(row.expires_at) <= now) continue;
    const record = store.getExecution(row.execution_id);
    if (!record) continue;
    let channels = 0;
    for (const rule of rules) {
      if (!watches(rule, record, store.getWorkflow(row.workflow_id))) continue;
      if (!alertStore.markWaitingSent(rule.id, `${ALERT_PREFIX}${row.id}`)) continue;
      await send(rule, approvalNotice(rule, row));
      channels += rule.channelIds.length;
    }
    if (channels && requestRow(row.id)) await recordNudge(row.id, { email: 0, channels });
  }
}
