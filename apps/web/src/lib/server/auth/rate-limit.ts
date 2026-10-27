/**
 * Rate limits for sign-in: a sliding window of attempt times per key (an IP address, an email) in memory, which is
 * enough for one process (a restart clears them). In queue mode (several mains) the counts live in Valkey instead, so an
 * attacker can't multiply the limit by the number of mains: a window per key that starts at its first failed attempt
 * (`AttemptLimiter`; if Valkey is unreachable the main's own memory counts, so the limit never disappears). Failed
 * sign-ins count; a successful one clears the email's window.
 */
import { clusterActive, coordinator } from '../cluster/state';
import { singleton } from '../singleton';
import { logger } from '../telemetry';

export interface RateLimitResult {
  ok: boolean;
  /** Seconds until the next attempt is allowed (when not ok). */
  retryAfter: number;
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  private recent(key: string, now: number): number[] {
    const list = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** Whether `key` may try now (doesn't count an attempt). */
  check(key: string, now = Date.now()): RateLimitResult {
    const list = this.recent(key, now);
    if (list.length < this.limit) return { ok: true, retryAfter: 0 };
    return { ok: false, retryAfter: Math.max(1, Math.ceil((list[0] + this.windowMs - now) / 1000)) };
  }

  /** Count an attempt. */
  hit(key: string, now = Date.now()) {
    this.sweep(now);
    this.hits.set(key, [...this.recent(key, now), now]);
  }

  reset(key: string) {
    this.hits.delete(key);
  }

  private sweep(now: number) {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const key of [...this.hits.keys()]) this.recent(key, now);
  }
}

/**
 * A `RateLimiter` per process, or in queue mode one counter per key in Valkey (`INCR` with the window as its time to live,
 * and the window's start beside it for `retryAfter`). The async twin of `RateLimiter`'s calls.
 */
export class AttemptLimiter {
  private readonly local: RateLimiter;

  constructor(
    private readonly name: string,
    readonly limit: number,
    readonly windowMs: number,
  ) {
    this.local = new RateLimiter(limit, windowMs);
  }

  private shared(): boolean {
    return clusterActive();
  }

  private key = (key: string) => `signin:${this.name}:${key}`;

  private fallback(error: unknown) {
    logger.warn('shared sign-in rate limit unavailable, counting in this process', { error: (error as Error).message });
  }

  async check(key: string, now = Date.now()): Promise<RateLimitResult> {
    if (!this.shared()) return this.local.check(key, now);
    try {
      const valkey = coordinator();
      const count = Number((await valkey.get(this.key(key))) ?? 0);
      if (count < this.limit) return { ok: true, retryAfter: 0 };
      const started = Number(await valkey.get(`${this.key(key)}:at`));
      const left = Number.isFinite(started) && started > 0 ? started + this.windowMs - now : this.windowMs;
      return { ok: false, retryAfter: Math.max(1, Math.ceil(Math.min(left, this.windowMs) / 1000)) };
    } catch (error) {
      this.fallback(error);
      return this.local.check(key, now);
    }
  }

  async hit(key: string, now = Date.now()): Promise<void> {
    // Always counted here too: it's the fallback while Valkey is away.
    this.local.hit(key, now);
    if (!this.shared()) return;
    try {
      const valkey = coordinator();
      if ((await valkey.incr(this.key(key), this.windowMs)) === 1) await valkey.set(`${this.key(key)}:at`, String(now), this.windowMs);
    } catch (error) {
      this.fallback(error);
    }
  }

  async reset(key: string): Promise<void> {
    this.local.reset(key);
    if (!this.shared()) return;
    try {
      await coordinator().del(this.key(key), `${this.key(key)}:at`);
    } catch (error) {
      this.fallback(error);
    }
  }
}

const WINDOW_MS = 15 * 60_000;
const envLimit = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

/** Sign-in limits: failed attempts per email (LANDFLOW_LOGIN_MAX_ATTEMPTS, default 10) and per IP (3×) in 15 minutes. */
export const loginLimits = () =>
  singleton('auth-login-limits', () => ({
    email: new AttemptLimiter('email', envLimit('LANDFLOW_LOGIN_MAX_ATTEMPTS', 10), WINDOW_MS),
    ip: new AttemptLimiter('ip', envLimit('LANDFLOW_LOGIN_MAX_ATTEMPTS', 10) * 3, WINDOW_MS),
  }));

/** Other unauthenticated forms (setup, invites, resets, forgot password): attempts per IP in 15 minutes. */
export const formLimit = () => singleton('auth-form-limit', () => new AttemptLimiter('form', 30, WINDOW_MS));

/** The caller's IP: the first X-Forwarded-For entry, X-Real-IP, else `local`. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return (forwarded || request.headers.get('x-real-ip')?.trim() || 'local').slice(0, 64);
}
