/**
 * In-memory rate limits for sign-in: a sliding window of attempt times per key (an IP address, an email). The host
 * is one process, so memory is enough; a restart clears them. Failed sign-ins count; a successful one clears the
 * email's window.
 */
import { singleton } from '../singleton';

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

const WINDOW_MS = 15 * 60_000;
const envLimit = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

/** Sign-in limits: failed attempts per email (LANDFLOW_LOGIN_MAX_ATTEMPTS, default 10) and per IP (3×) in 15 minutes. */
export const loginLimits = () =>
  singleton('auth-login-limits', () => ({
    email: new RateLimiter(envLimit('LANDFLOW_LOGIN_MAX_ATTEMPTS', 10), WINDOW_MS),
    ip: new RateLimiter(envLimit('LANDFLOW_LOGIN_MAX_ATTEMPTS', 10) * 3, WINDOW_MS),
  }));

/** Other unauthenticated forms (setup, invites, resets, forgot password): attempts per IP in 15 minutes. */
export const formLimit = () => singleton('auth-form-limit', () => new RateLimiter(30, WINDOW_MS));

/** The caller's IP: the first X-Forwarded-For entry, X-Real-IP, else `local`. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return (forwarded || request.headers.get('x-real-ip')?.trim() || 'local').slice(0, 64);
}
