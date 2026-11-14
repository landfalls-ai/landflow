/**
 * Standard Webhooks (https://www.standardwebhooks.com/), as Clickland signs its deliveries: `webhook-signature` holds
 * space-delimited `v1,<base64 HMAC-SHA256>` values over `<webhook-id>.<webhook-timestamp>.<raw body>`, keyed with the
 * base64-decoded part of the `whsec_…` secret after the prefix; the timestamp (Unix seconds) must be within the
 * tolerance, so a captured delivery cannot be replayed later. The same scheme as the Fathom plugin's verifier.
 */
import { DEFAULT_SIGNATURE_TOLERANCE_SECONDS, hmacSha256, safeEqual } from '@landflow/sdk';

export const TOLERANCE_SECONDS = DEFAULT_SIGNATURE_TOLERANCE_SECONDS;

export interface WebhookHeaders {
  id?: string | null;
  timestamp?: string | null;
  signature?: string | null;
}

const keyOf = (secret: string) => Buffer.from(secret.trim().replace(/^whsec_/, ''), 'base64');

/** Whether one of the `v1,` signatures signs this delivery, and its timestamp is fresh. */
export function verifyStandardWebhook(secret: string, rawBody: string | Uint8Array, headers: WebhookHeaders, options: { toleranceSeconds?: number; now?: number } = {}): boolean {
  const { toleranceSeconds = TOLERANCE_SECONDS, now = Date.now() } = options;
  const id = headers.id?.trim();
  const stamp = headers.timestamp?.trim() ?? '';
  const timestamp = Number(stamp);
  if (!secret.trim() || !id || !headers.signature || !/^\d+$/.test(stamp) || !Number.isFinite(timestamp)) return false;
  if (Math.abs(now / 1000 - timestamp) > toleranceSeconds) return false;
  const key = keyOf(secret);
  if (key.length === 0) return false;
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody) : Buffer.from(rawBody);
  const expected = hmacSha256(key, Buffer.concat([Buffer.from(`${id}.${stamp}.`), body]), 'base64');
  return headers.signature.split(/\s+/).some((entry) => {
    const comma = entry.indexOf(',');
    return comma > 0 && entry.slice(0, comma) === 'v1' && safeEqual(entry.slice(comma + 1), expected);
  });
}

/** A `webhook-signature` value for tests and tools. */
export function signStandardWebhook(secret: string, rawBody: string, id: string, timestamp: number): string {
  return `v1,${hmacSha256(keyOf(secret), `${id}.${timestamp}.${rawBody}`, 'base64')}`;
}
