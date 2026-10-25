/**
 * Four-eyes notifications: a new publish request goes to the approvers (email over the host's SMTP settings, when
 * Settings → Governance has "Email approvers" on and SMTP is configured) and to the alert channels picked there
 * (Settings → Alerts: email, Slack, signed webhook, Telegram); a decision goes back to the requester by email.
 * Sending happens in the background and never fails the request; failures are logged.
 */
import { createHmac } from 'node:crypto';
import type { PublishRequestView } from '../../shared/governance';
import { mailConfigured, sendMail } from '../auth/mail';
import { getUser, listUsers } from '../auth/users';
import { publicUrl } from '../alerts/message';
import { alertStore, emailAddresses } from '../alerts/store';
import { credentials } from '../credentials/vault';
import { logger } from '../telemetry/logger';

const TIMEOUT_MS = 10_000;

export type RequestNotice = 'created' | 'approved' | 'rejected' | 'failed';

const KIND: Record<PublishRequestView['kind'], string> = { publish: 'publish', rollback: 'roll back', unpublish: 'unpublish' };

export const requestUrl = (request: Pick<PublishRequestView, 'workflowId'>) => `${publicUrl()}/workflows/${encodeURIComponent(request.workflowId)}?publishRequests=1`;

export function noticeText(request: PublishRequestView, notice: RequestNotice): { subject: string; text: string } {
  const who = request.requestedByName ?? request.requestedBy;
  const version = request.versionNumber !== undefined ? ` version ${request.versionNumber}` : '';
  const lines: string[] = [];
  let subject: string;
  if (notice === 'created') {
    subject = `Approval needed: ${who} wants to ${KIND[request.kind]} “${request.workflowName}”`;
    lines.push(`${who} asked to ${KIND[request.kind]} “${request.workflowName}”${version}.`);
    if (request.diff?.summary) lines.push(`Changes: ${request.diff.summary}`);
    if (request.note) lines.push(`Note: ${request.note}`);
    lines.push('', `Review it: ${requestUrl(request)}`);
  } else {
    const by = request.decidedByName ?? request.decidedBy ?? 'Someone';
    const verb = notice === 'approved' ? 'approved' : notice === 'rejected' ? 'rejected' : 'approved, but publishing failed for';
    subject = `${notice === 'approved' ? 'Approved' : notice === 'rejected' ? 'Rejected' : 'Publish failed'}: ${KIND[request.kind]} “${request.workflowName}”`;
    lines.push(`${by} ${verb} your request to ${KIND[request.kind]} “${request.workflowName}”${version}.`);
    if (request.comment) lines.push(`Comment: ${request.comment}`);
    if (notice === 'failed' && request.reason) lines.push(`Reason: ${request.reason}`);
    lines.push('', requestUrl(request));
  }
  return { subject, text: lines.join('\n') };
}

async function post(url: string, body: string, headers: Record<string, string>): Promise<void> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Landflow-Governance/1', ...headers }, body, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

/** Send through one alert channel (Settings → Alerts). */
async function sendThroughChannel(channelId: string, request: PublishRequestView, notice: RequestNotice) {
  const channel = alertStore.channelForSending(channelId);
  if (!channel) return;
  const { subject, text } = noticeText(request, notice);
  const { config } = channel;
  switch (channel.kind) {
    case 'email':
      if (!mailConfigured()) throw new Error('Email is not configured (LANDFLOW_SMTP_HOST)');
      for (const to of emailAddresses(config.to)) await sendMail({ to, subject, text });
      return;
    case 'slack':
      if (config.webhookUrl) await post(config.webhookUrl, JSON.stringify({ text: `*${subject}*\n${text}` }), {});
      return;
    case 'webhook': {
      if (!config.url) return;
      const body = JSON.stringify({ event: `publish_request.${notice}`, subject, text, request, url: requestUrl(request), at: new Date().toISOString() });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const headers: Record<string, string> = { 'x-landflow-event': `publish_request.${notice}`, 'x-landflow-timestamp': timestamp };
      if (config.secret) headers['x-landflow-signature'] = `sha256=${createHmac('sha256', config.secret).update(`${timestamp}.${body}`).digest('hex')}`;
      await post(config.url, body, headers);
      return;
    }
    case 'telegram': {
      if (!config.credentialId || !config.chatId) return;
      const data = credentials.dataFor({ id: config.credentialId, name: `of channel "${channel.name}"` }, 'messaging.telegramApi');
      const token = String(data.accessToken ?? '').trim();
      if (!token) return;
      const base = String(data.baseUrl || 'https://api.telegram.org').replace(/\/+$/, '');
      await post(`${base}/bot${token}/sendMessage`, JSON.stringify({ chat_id: config.chatId, text: `${subject}\n\n${text}`, disable_web_page_preview: true }), {});
      return;
    }
  }
}

/** A new request: email the approvers (`approverIds`) and tell the channels. Background; never throws. */
export function notifyApprovers(request: PublishRequestView, options: { email: boolean; channelIds: string[]; approverIds: string[] }) {
  const { subject, text } = noticeText(request, 'created');
  const jobs: Promise<unknown>[] = [];
  if (options.email && mailConfigured()) {
    const emails = new Set(listUsers().filter((u) => options.approverIds.includes(u.id) && !u.disabledAt && u.email).map((u) => u.email));
    for (const to of emails) jobs.push(sendMail({ to, subject, text }));
  }
  for (const id of options.channelIds) jobs.push(sendThroughChannel(id, request, 'created'));
  void Promise.allSettled(jobs).then((results) => {
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed.length) logger.warn('could not notify every approver of a publish request', { 'landflow.publish_request.id': request.id, error: String(failed[0].reason?.message ?? failed[0].reason) });
  });
}

/** A decision: email the requester. Background; never throws. */
export function notifyRequester(request: PublishRequestView, notice: Exclude<RequestNotice, 'created'>, options: { email: boolean }) {
  if (!options.email || !mailConfigured()) return;
  const requester = getUser(request.requestedBy);
  if (!requester?.email) return;
  const { subject, text } = noticeText(request, notice);
  void sendMail({ to: requester.email, subject, text }).catch((error) => logger.warn('could not email the requester of a publish request', { 'landflow.publish_request.id': request.id, error: (error as Error).message }));
}
