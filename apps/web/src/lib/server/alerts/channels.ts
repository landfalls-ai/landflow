/**
 * Sending one alert through one channel. Email goes through the host's SMTP settings (lib/server/auth/mail, the
 * LANDFLOW_SMTP_* variables invites use), one message per address; Slack through an incoming webhook; a webhook
 * channel POSTs JSON signed with HMAC-SHA256 (`X-Landflow-Signature: sha256=<hex of HMAC(secret, "<timestamp>.<body>")>`,
 * `X-Landflow-Timestamp` in seconds); Telegram through a saved Telegram API credential's bot. Each returns what the
 * receiver said and throws an Error with the reason when it refused.
 */
import { createHmac } from 'node:crypto';
import type { AlertChannel, AlertChannelConfig } from '../../shared/alerts';
import { mailConfigured, sendMail } from '../auth/mail';
import { credentials } from '../credentials/vault';
import { emailAddresses } from './store';
import { htmlOf, slackPayload, subjectOf, telegramText, textOf, webhookPayload, type AlertNotice } from './message';

const TIMEOUT_MS = 10_000;
const TELEGRAM_CREDENTIAL = 'messaging.telegramApi';
const TELEGRAM_API = 'https://api.telegram.org';

export type SendableChannel = Pick<AlertChannel, 'id' | 'name' | 'kind'> & { config: AlertChannelConfig };

/** The signature header value of a webhook body. */
export function signature(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** A short reason from a refused HTTP call: the status and the start of the body. */
async function refusal(response: Response, what: string): Promise<Error> {
  const body = (await response.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200);
  return new Error(`${what} answered HTTP ${response.status}${body ? `: ${body}` : ''}`);
}

async function post(url: string, body: string, headers: Record<string, string>, what: string): Promise<Response> {
  try {
    return await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Landflow-Alerts/1', ...headers }, body, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual' });
  } catch (error) {
    const reason = (error as Error).name === 'TimeoutError' ? `no answer within ${TIMEOUT_MS / 1000} s` : ((error as Error & { cause?: Error }).cause?.message ?? (error as Error).message);
    throw new Error(`${what} could not be reached: ${reason}`);
  }
}

async function sendEmail(config: AlertChannelConfig, notice: AlertNotice): Promise<string> {
  const addresses = emailAddresses(config.to);
  if (!addresses.length) throw new Error('No email address');
  if (!mailConfigured()) throw new Error('Email is not configured (LANDFLOW_SMTP_HOST)');
  const message = { subject: subjectOf(notice), text: textOf(notice), html: htmlOf(notice) };
  // One message per address (the mailer takes one recipient), one connection at a time; a failure doesn't stop the rest.
  const failed: string[] = [];
  for (const to of addresses) {
    try {
      await sendMail({ ...message, to });
    } catch (error) {
      failed.push(addresses.length === 1 ? (error as Error).message : `${to}: ${(error as Error).message}`);
    }
  }
  if (failed.length) throw new Error(addresses.length === 1 ? failed[0] : `Not sent to ${failed.join('; ')}`);
  return `Sent to ${addresses.join(', ')}`;
}

async function sendSlack(config: AlertChannelConfig, notice: AlertNotice): Promise<string> {
  if (!config.webhookUrl) throw new Error('No Slack webhook URL');
  const response = await post(config.webhookUrl, JSON.stringify(slackPayload(notice)), {}, 'Slack');
  if (!response.ok) throw await refusal(response, 'Slack');
  return `Slack answered ${(await response.text().catch(() => '')).trim().slice(0, 60) || response.status}`;
}

async function sendWebhook(config: AlertChannelConfig, notice: AlertNotice): Promise<string> {
  if (!config.url) throw new Error('No webhook URL');
  const body = JSON.stringify(webhookPayload(notice));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = { 'x-landflow-event': notice.digest ? 'alert.digest' : notice.test ? 'alert.test' : 'alert', 'x-landflow-timestamp': timestamp };
  if (config.secret) headers['x-landflow-signature'] = signature(config.secret, timestamp, body);
  const response = await post(config.url, body, headers, 'The webhook');
  if (!response.ok) throw await refusal(response, 'The webhook');
  return `HTTP ${response.status}`;
}

async function sendTelegram(channel: SendableChannel, notice: AlertNotice): Promise<string> {
  const { credentialId, chatId } = channel.config;
  if (!credentialId || !chatId) throw new Error('Choose a Telegram credential and a chat ID');
  const data = credentials.dataFor({ id: credentialId, name: `of channel "${channel.name}"` }, TELEGRAM_CREDENTIAL);
  const token = String(data.accessToken ?? '').trim();
  if (!token) throw new Error('The Telegram credential has no access token');
  const base = String(data.baseUrl || TELEGRAM_API).replace(/\/+$/, '');
  const response = await post(`${base}/bot${token}/sendMessage`, JSON.stringify({ chat_id: chatId, text: telegramText(notice), parse_mode: 'HTML', disable_web_page_preview: true }), {}, 'Telegram');
  const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  if (!response.ok || answer.ok === false) throw new Error(`Telegram answered HTTP ${response.status}: ${answer.description ?? 'error'}`);
  return 'Telegram accepted it';
}

/** Send `notice` through `channel`; resolves with the receiver's answer, rejects with the reason it failed. */
export async function sendThrough(channel: SendableChannel, notice: AlertNotice): Promise<string> {
  switch (channel.kind) {
    case 'email':
      return sendEmail(channel.config, notice);
    case 'slack':
      return sendSlack(channel.config, notice);
    case 'webhook':
      return sendWebhook(channel.config, notice);
    case 'telegram':
      return sendTelegram(channel, notice);
  }
}
