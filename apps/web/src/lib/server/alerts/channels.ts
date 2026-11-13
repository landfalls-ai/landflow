/**
 * Sending one alert through one channel. Email goes through the host's SMTP settings (lib/server/auth/mail, the
 * LANDFLOW_SMTP_* variables invites use), one message per address; Slack, Microsoft Teams (an Adaptive Card) and Discord (an embed) through their webhooks; a webhook
 * channel POSTs JSON signed with HMAC-SHA256 (`X-Landflow-Signature: sha256=<hex of HMAC(secret, "<timestamp>.<body>")>`,
 * `X-Landflow-Timestamp` in seconds); Telegram through a saved Telegram API credential's bot. Each returns what the
 * receiver said and throws an Error with the reason when it refused.
 *
 * External secrets: the Telegram credential's fields and the channel's Slack, Teams and Discord webhook URL, webhook URL and signing
 * secret may read `{{ $secrets.<provider>.<name> }}`, resolved right before sending (same cache and redaction as
 * credential fields in nodes); a reason that would quote a resolved value is redacted.
 */
import { createHmac } from 'node:crypto';
import type { AlertChannel, AlertChannelConfig } from '../../shared/alerts';
import { mailConfigured, sendMail } from '../auth/mail';
import { credentials } from '../credentials/vault';
import { safeFetch } from '../net/safe-fetch';
import { redactText } from '../secrets/redact';
import { resolveSecretFields } from '../secrets/resolve';
import { emailAddresses } from './store';
import { discordPayload, htmlOf, slackPayload, subjectOf, teamsPayload, telegramText, textOf, webhookPayload, type AlertNotice } from './message';

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
    return await safeFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Landflow-Alerts/1', ...headers }, body, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual' });
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

async function sendTeams(config: AlertChannelConfig, notice: AlertNotice): Promise<string> {
  if (!config.webhookUrl) throw new Error('No Microsoft Teams webhook URL');
  const response = await post(config.webhookUrl, JSON.stringify(teamsPayload(notice)), {}, 'Microsoft Teams');
  // A Workflows webhook answers 202 Accepted; the legacy incoming webhook 200 with "1". Both are in the 2xx range.
  if (!response.ok) throw await refusal(response, 'Microsoft Teams');
  return `Microsoft Teams accepted it (HTTP ${response.status})`;
}

async function sendDiscord(config: AlertChannelConfig, notice: AlertNotice): Promise<string> {
  if (!config.webhookUrl) throw new Error('No Discord webhook URL');
  const response = await post(config.webhookUrl, JSON.stringify(discordPayload(notice)), {}, 'Discord');
  if (!response.ok) throw await refusal(response, 'Discord');
  return `Discord accepted it (HTTP ${response.status})`;
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
  const data = await telegramCredential(channel);
  const token = String(data.accessToken ?? '').trim();
  if (!token) throw new Error('The Telegram credential has no access token');
  const base = String(data.baseUrl || TELEGRAM_API).replace(/\/+$/, '');
  const response = await post(`${base}/bot${token}/sendMessage`, JSON.stringify({ chat_id: chatId, text: telegramText(notice), parse_mode: 'HTML', disable_web_page_preview: true }), {}, 'Telegram');
  const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  if (!response.ok || answer.ok === false) throw new Error(`Telegram answered HTTP ${response.status}: ${answer.description ?? 'error'}`);
  return 'Telegram accepted it';
}

/** A channel's settings with `$secrets` resolved in what Landflow sends with: the webhook URLs and the signing secret. */
export function channelConfigWithSecrets(channel: SendableChannel): Promise<AlertChannelConfig> {
  return resolveSecretFields(channel.config, `Alert channel “${channel.name}”`, ['webhookUrl', 'url', 'secret']);
}

/** The data of a Telegram channel's credential, `$secrets` resolved. */
export function telegramCredential(channel: SendableChannel) {
  return credentials.dataWithSecrets({ id: channel.config.credentialId ?? '', name: `of channel "${channel.name}"` }, TELEGRAM_CREDENTIAL);
}

/** Send `notice` through `channel`; resolves with the receiver's answer, rejects with the reason it failed. */
export async function sendThrough(channel: SendableChannel, notice: AlertNotice): Promise<string> {
  try {
    const resolved = { ...channel, config: await channelConfigWithSecrets(channel) };
    switch (resolved.kind) {
      case 'email':
        return await sendEmail(resolved.config, notice);
      case 'slack':
        return await sendSlack(resolved.config, notice);
      case 'webhook':
        return await sendWebhook(resolved.config, notice);
      case 'telegram':
        return await sendTelegram(resolved, notice);
      case 'teams':
        return await sendTeams(resolved.config, notice);
      case 'discord':
        return await sendDiscord(resolved.config, notice);
    }
  } catch (error) {
    throw new Error(redactText((error as Error).message));
  }
}
