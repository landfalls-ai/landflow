/**
 * The outbound primitives shared by the alert channels (./channels.ts) and the ticket calls (./tickets.ts): one HTTP call
 * through safeFetch, the webhook signature, a refusal's short reason, and a channel's settings with `$secrets` resolved.
 */
import { createHmac } from 'node:crypto';
import type { AlertChannel, AlertChannelConfig } from '../../shared/alerts';
import { safeFetch } from '../net/safe-fetch';
import { resolveSecretFields } from '../secrets/resolve';

const TIMEOUT_MS = 10_000;

export type SendableChannel = Pick<AlertChannel, 'id' | 'name' | 'kind'> & { config: AlertChannelConfig };

/** The signature header value of a webhook body. */
export function signature(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** The most of an answer a channel reads: a ticket system's answer is a small JSON object or a short reason. */
export const MAX_ANSWER_BYTES = 64 * 1024;

/** The answer's body as text, or undefined when it runs past `limit` bytes (the rest is not read). */
export async function readCapped(response: Response, limit = MAX_ANSWER_BYTES): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) return undefined;
      chunks.push(value);
    }
  } catch {
    return undefined;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The answer as JSON; an empty object when it is too long, empty or not JSON. */
export async function readJson<T extends object>(response: Response): Promise<Partial<T>> {
  try {
    return JSON.parse((await readCapped(response)) ?? '') as Partial<T>;
  } catch {
    return {};
  }
}

/** A short reason from a refused HTTP call: the status and the start of the body. */
export async function refusal(response: Response, what: string): Promise<Error> {
  const body = ((await readCapped(response)) ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return new Error(`${what} answered HTTP ${response.status}${body ? `: ${body}` : ''}`);
}

/** One outbound call (through safeFetch, 10 s, no redirects); a failure to connect says what could not be reached. */
export async function request(method: 'POST' | 'PATCH', url: string, body: string, headers: Record<string, string>, what: string): Promise<Response> {
  try {
    return await safeFetch(url, { method, headers: { 'content-type': 'application/json', 'user-agent': 'Landflow-Alerts/1', ...headers }, body, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual' });
  } catch (error) {
    const reason = (error as Error).name === 'TimeoutError' ? `no answer within ${TIMEOUT_MS / 1000} s` : ((error as Error & { cause?: Error }).cause?.message ?? (error as Error).message);
    throw new Error(`${what} could not be reached: ${reason}`);
  }
}

/** A channel's settings with `$secrets` resolved in what Landflow sends with: the webhook URLs and the signing secret. */
export function channelConfigWithSecrets(channel: SendableChannel): Promise<AlertChannelConfig> {
  return resolveSecretFields(channel.config, `Alert channel “${channel.name}”`, ['webhookUrl', 'url', 'secret']);
}
