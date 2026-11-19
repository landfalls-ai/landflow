/**
 * A token bucket per credential id, shared by every link that uses one key (docs/features/notion-brain.md#how-landflow-talks-to-notion):
 * the rate is the highest `rps` asked for that key (2 by default, at most 8), burst 3, plus a second bucket for data source
 * queries (at most 2.5 a second). Five 429s in a row halve the rate for ten minutes. Callers reserve a token synchronously and
 * then wait, so concurrent callers queue in order.
 */
import { singleton } from '../singleton';

export const RPS_DEFAULT = 2;
export const RPS_MAX = 8;
export const BURST = 3;
export const QUERY_RPS_MAX = 2.5;
export const HALVE_AFTER = 5;
export const HALVE_MS = 10 * 60_000;

interface Bucket {
  tokens: number;
  at: number;
}

interface Limiter {
  rps: number;
  general: Bucket;
  query: Bucket;
  straight429: number;
  halvedUntil: number;
}

const limiters = () => singleton('notion-limiters', () => new Map<string, Limiter>());

const clampRps = (rps: number | undefined) => Math.min(RPS_MAX, Math.max(0.1, rps && Number.isFinite(rps) ? rps : RPS_DEFAULT));

function limiterOf(credentialId: string, rps: number | undefined, now: number): Limiter {
  const map = limiters();
  let limiter = map.get(credentialId);
  if (!limiter) {
    limiter = { rps: clampRps(rps), general: { tokens: BURST, at: now }, query: { tokens: BURST, at: now }, straight429: 0, halvedUntil: 0 };
    map.set(credentialId, limiter);
  } else if (rps !== undefined) {
    limiter.rps = Math.max(limiter.rps, clampRps(rps));
  }
  return limiter;
}

/** The rate now in force for a credential (requests a second). */
export function currentRate(credentialId: string, now: number): number {
  const limiter = limiters().get(credentialId);
  if (!limiter) return RPS_DEFAULT;
  return limiter.halvedUntil > now ? limiter.rps / 2 : limiter.rps;
}

function take(bucket: Bucket, rate: number, now: number): number {
  bucket.tokens = Math.min(BURST, bucket.tokens + Math.max(0, now - bucket.at) * (rate / 1000));
  bucket.at = now;
  bucket.tokens -= 1;
  return bucket.tokens < 0 ? Math.ceil((-bucket.tokens / rate) * 1000) : 0;
}

/** Reserve one request; resolves when its turn comes. `query`: a data source query, which also takes from the query bucket. */
export async function acquire(credentialId: string, options: { rps?: number; query?: boolean; now: () => number; sleep: (ms: number) => Promise<void> }): Promise<void> {
  const now = options.now();
  const limiter = limiterOf(credentialId, options.rps, now);
  const rate = limiter.halvedUntil > now ? limiter.rps / 2 : limiter.rps;
  let wait = take(limiter.general, rate, now);
  if (options.query) wait = Math.max(wait, take(limiter.query, Math.min(QUERY_RPS_MAX, rate), now));
  if (wait > 0) await options.sleep(wait);
}

/** A 429 came back (not a `blocked` one): five in a row halve the rate for ten minutes. */
export function noteRateLimited(credentialId: string, now: number): void {
  const limiter = limiters().get(credentialId);
  if (!limiter) return;
  limiter.straight429 += 1;
  if (limiter.straight429 >= HALVE_AFTER) {
    limiter.halvedUntil = now + HALVE_MS;
    limiter.straight429 = 0;
  }
}

/** A request was answered by anything but 429: the streak ends. */
export function noteAnswered(credentialId: string): void {
  const limiter = limiters().get(credentialId);
  if (limiter) limiter.straight429 = 0;
}

/** Forget every limiter (tests). */
export function resetLimiters(): void {
  limiters().clear();
}
