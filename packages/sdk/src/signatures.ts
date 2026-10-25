/**
 * Webhook signature verification: HMAC-SHA256 over the raw request body, as GitHub (`X-Hub-Signature-256`), Stripe
 * (`Stripe-Signature: t=…,v1=…`) and Slack (`X-Slack-Signature` with `X-Slack-Request-Timestamp`) sign their calls.
 * App webhook triggers (docs/protocol.md §12) call these from `webhook()` with `ctx.getRawBody()`; the Go and Python
 * SDKs have the same helpers. Comparisons are constant-time; timestamped schemes reject calls older (or newer) than
 * the tolerance, so a captured request cannot be replayed later.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** How far a signed timestamp may be from now (Stripe's and Slack's default: five minutes). */
export const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;

export type SignatureInput = string | Uint8Array;

/** HMAC-SHA256 of `payload` with `secret`, hex (default) or base64. */
export function hmacSha256(secret: SignatureInput, payload: SignatureInput, encoding: 'hex' | 'base64' = 'hex'): string {
  return createHmac('sha256', secret).update(payload).digest(encoding);
}

/** Constant-time string comparison (false for different lengths). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Whether `signature` (optionally after `prefix`, e.g. `sha256=`) is the HMAC-SHA256 of `payload`. Hex is compared case-insensitively. */
export function verifyHmacSha256(options: { secret: SignatureInput; payload: SignatureInput; signature: string | null | undefined; encoding?: 'hex' | 'base64'; prefix?: string }): boolean {
  const { secret, payload, encoding = 'hex', prefix = '' } = options;
  let signature = String(options.signature ?? '').trim();
  if (!signature || !secretLength(secret)) return false;
  if (prefix) {
    if (!signature.toLowerCase().startsWith(prefix.toLowerCase())) return false;
    signature = signature.slice(prefix.length);
  }
  const expected = hmacSha256(secret, payload, encoding);
  return encoding === 'hex' ? safeEqual(signature.toLowerCase(), expected) : safeEqual(signature, expected);
}

const secretLength = (secret: SignatureInput) => (typeof secret === 'string' ? secret.length : secret.byteLength);

function fresh(timestamp: number, toleranceSeconds: number, now: number): boolean {
  return Number.isFinite(timestamp) && Math.abs(now / 1000 - timestamp) <= toleranceSeconds;
}

// ---- GitHub ---------------------------------------------------------------

/** GitHub's `X-Hub-Signature-256` value for a body: `sha256=<hex>`. */
export function githubSignature(secret: SignatureInput, body: SignatureInput): string {
  return `sha256=${hmacSha256(secret, body)}`;
}

/** Whether `header` (`X-Hub-Signature-256`) signs `body` with the webhook's secret. */
export function verifyGitHubSignature(secret: SignatureInput, body: SignatureInput, header: string | null | undefined): boolean {
  return verifyHmacSha256({ secret, payload: body, signature: header, prefix: 'sha256=' });
}

// ---- Stripe-style: t=<unix seconds>,v1=<hex> ------------------------------

/** A `Stripe-Signature` value: `t=<timestamp>,v1=<hmac of "<timestamp>.<body>">`. */
export function stripeSignature(secret: SignatureInput, body: SignatureInput, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${hmacSha256(secret, Buffer.concat([Buffer.from(`${timestamp}.`), Buffer.from(body)]))}`;
}

/**
 * Whether a `Stripe-Signature`-style header (`t=…,v1=…`, several `v1` allowed during secret rotation) signs `body`,
 * with `t` within `toleranceSeconds` of `now` (ms).
 */
export function verifyStripeSignature(
  secret: SignatureInput,
  body: SignatureInput,
  header: string | null | undefined,
  options: { toleranceSeconds?: number; now?: number; scheme?: string } = {},
): boolean {
  const { toleranceSeconds = DEFAULT_SIGNATURE_TOLERANCE_SECONDS, now = Date.now(), scheme = 'v1' } = options;
  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of String(header ?? '').split(',')) {
    const [key, ...rest] = part.trim().split('=');
    const value = rest.join('=');
    if (key === 't') timestamp = value;
    else if (key === scheme && value) signatures.push(value);
  }
  if (!timestamp || !/^\d+$/.test(timestamp) || !signatures.length || !fresh(Number(timestamp), toleranceSeconds, now)) return false;
  const payload = Buffer.concat([Buffer.from(`${timestamp}.`), Buffer.from(body)]);
  return signatures.some((signature) => verifyHmacSha256({ secret, payload, signature }));
}

// ---- Slack: v0=<hex of "v0:<timestamp>:<body>"> ---------------------------

/** Slack's `X-Slack-Signature` for a body sent at `timestamp` (unix seconds, the `X-Slack-Request-Timestamp` header). */
export function slackSignature(signingSecret: SignatureInput, body: SignatureInput, timestamp: number | string): string {
  return `v0=${hmacSha256(signingSecret, Buffer.concat([Buffer.from(`v0:${timestamp}:`), Buffer.from(body)]))}`;
}

/** Whether Slack's `X-Slack-Signature` signs `body` with the app's signing secret, sent within the tolerance. */
export function verifySlackSignature(
  signingSecret: SignatureInput,
  body: SignatureInput,
  timestamp: string | number | null | undefined,
  signature: string | null | undefined,
  options: { toleranceSeconds?: number; now?: number } = {},
): boolean {
  const { toleranceSeconds = DEFAULT_SIGNATURE_TOLERANCE_SECONDS, now = Date.now() } = options;
  const ts = String(timestamp ?? '').trim();
  if (!/^\d+$/.test(ts) || !fresh(Number(ts), toleranceSeconds, now)) return false;
  const payload = Buffer.concat([Buffer.from(`v0:${ts}:`), Buffer.from(body)]);
  return verifyHmacSha256({ secret: signingSecret, payload, signature, prefix: 'v0=' });
}
