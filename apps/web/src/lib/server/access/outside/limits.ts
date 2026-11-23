/**
 * The abuse limits of people without a Landflow account (docs/access-requests.md#limits), in one place: how many sign-in links one address,
 * one network address and one domain can ask for, how many wrong links one address can try, and `takeOutside` for the chat. The sign-in
 * limiters are `AttemptLimiter`s (process memory, or Valkey in queue mode so several mains share them). None is a setting: a limit that
 * can be switched off is a limit an abuser asks an admin to switch off.
 */
import { AttemptLimiter } from '../../auth/rate-limit';
import { windowHit } from '../../rate-limit/api-limiter';
import { singleton } from '../../singleton';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The numbers, so the docs and the tests read them from here. */
export const OUTSIDE_LIMITS = {
  /** Links one address may ask for. */
  addressWindow: { limit: 3, windowMs: 15 * MINUTE },
  addressDay: { limit: 10, windowMs: DAY },
  /** Asks for a link from one network address (the one limit an asker sees: 429). */
  ip: { limit: 10, windowMs: 15 * MINUTE },
  /** Links one email domain gets in an hour: past it, no mail goes out and the admin sees an audit row. */
  domain: { limit: 200, windowMs: HOUR },
  /** Wrong or used links one network address may try. */
  verifyFailures: { limit: 20, windowMs: 15 * MINUTE },
  /** Starts of Google sign-in from one network address. */
  googleStarts: { limit: 20, windowMs: 15 * MINUTE },
} as const;

const makeLimiters = () => ({
  address: new AttemptLimiter('outside-address', OUTSIDE_LIMITS.addressWindow.limit, OUTSIDE_LIMITS.addressWindow.windowMs),
  addressDay: new AttemptLimiter('outside-address-day', OUTSIDE_LIMITS.addressDay.limit, OUTSIDE_LIMITS.addressDay.windowMs),
  ip: new AttemptLimiter('outside-ip', OUTSIDE_LIMITS.ip.limit, OUTSIDE_LIMITS.ip.windowMs),
  domain: new AttemptLimiter('outside-domain', OUTSIDE_LIMITS.domain.limit, OUTSIDE_LIMITS.domain.windowMs),
  verifyFailures: new AttemptLimiter('outside-verify', OUTSIDE_LIMITS.verifyFailures.limit, OUTSIDE_LIMITS.verifyFailures.windowMs),
  googleStarts: new AttemptLimiter('outside-google', OUTSIDE_LIMITS.googleStarts.limit, OUTSIDE_LIMITS.googleStarts.windowMs),
});

const held = () => singleton('access-outside-limiters', () => ({ limiters: makeLimiters() }));
export const outsideLimiters = () => held().limiters;

interface Bucket {
  hits: number[];
}
const MAX_KEYS = 20_000;
const local = () => singleton('access-outside-take', () => new Map<string, Bucket>());

/**
 * Count one use of `key` in `bucket` and say whether it is within `limit` in the last `windowMs` (a sliding window in this process). Used
 * by the chat; synchronous, so a route can refuse before doing anything. Several mains each count their own: use `takeOutsideShared`
 * where that matters. A refused use is not counted.
 */
export function takeOutside(bucket: string, key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const map = local();
  const id = `${bucket}:${key}`;
  const entry = map.get(id) ?? { hits: [] };
  entry.hits = entry.hits.filter((at) => now - at < windowMs);
  if (entry.hits.length >= limit) {
    map.set(id, entry);
    return false;
  }
  entry.hits.push(now);
  // A key over the cap drops the oldest one (Map keeps insertion order), so forged keys can't grow the map.
  if (!map.has(id) && map.size >= MAX_KEYS) map.delete(map.keys().next().value!);
  map.set(id, entry);
  return true;
}

/** `takeOutside` through the API limiter's store (Valkey in queue mode, shared by every main). */
export async function takeOutsideShared(bucket: string, key: string, limit: number, windowMs: number): Promise<boolean> {
  return (await windowHit(`outside:${bucket}:${key}`, limit, windowMs)).allowed;
}

/** Tests: forget every count (in this process; Valkey keys expire on their own). */
export function resetOutsideLimits(): void {
  local().clear();
  held().limiters = makeLimiters();
}
