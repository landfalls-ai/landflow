/**
 * Rate limits for the API itself (sign-in forms have their own in auth/rate-limit.ts): a counter per signed-in
 * principal for authenticated calls (LANDFLOW_RATE_LIMIT_API a minute) and one per client address and route group
 * for the public triggers (/api/webhook, /form, /chat, /mcp, /api/waiting, /api/gateway-parts:
 * LANDFLOW_RATE_LIMIT_PUBLIC a minute), so a public endpoint that starts model calls can't be driven for cost.
 * Defaults: 600 and 120 in the production profile, off (0) in development; 0 turns a bucket off anywhere. Fixed
 * one-minute windows: in queue mode the count lives in Valkey (the coordinator's `incr`, shared by every main), else in
 * this process; if Valkey is unreachable the process counts, so the limit never disappears. Health checks, plugin heartbeats and /api/metrics are never counted.
 * `handler` (lib/server/http.ts) calls `limitRequest` right after the guard let the request in.
 */
import { envInt, isProduction } from '../config';
import { clusterActive, coordinator } from '../cluster/state';
import { clientAddress } from '../net/client-address';
import { singleton } from '../singleton';
import { logger } from '../telemetry/logger';
import { countRateLimitRefused } from './counters';

const WINDOW_MS = 60_000;
/** Keys this process counts at most: past it, the oldest key is dropped, so forged addresses can't grow the map within a window. */
export const MAX_LOCAL_KEYS = 50_000;

/** Never limited: liveness probes, plugin heartbeats and the metrics scrape. */
const EXEMPT = ['/api/health', '/api/plugins/announce', '/api/metrics'];

const HARNESS_HOOK = /^\/api\/harness\/[^/]+\/hooks$/;

/** The public trigger groups: a prefix matches itself and everything below it. */
const PUBLIC_GROUPS: Array<[group: string, prefix: string]> = [
  ['webhook', '/api/webhook'],
  ['form', '/form'],
  ['chat', '/chat'],
  ['mcp', '/mcp'],
  ['waiting', '/api/waiting'],
  // Unauthenticated (signed by the gateway's secret): each request still costs a body read and an HMAC.
  ['gateway-parts', '/api/gateway-parts'],
  // The docs for agents: one 1.1 MB file a request, so both files share a group per address.
  ['llms', '/llms.txt'],
  ['llms', '/llms-full.txt'],
];

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/** Requests a minute for a bucket (0 = off), read on each call so a test or a restart-free change takes effect. */
export function apiLimit(bucket: 'api' | 'public'): number {
  const name = bucket === 'api' ? 'LANDFLOW_RATE_LIMIT_API' : 'LANDFLOW_RATE_LIMIT_PUBLIC';
  const fallback = isProduction() ? (bucket === 'api' ? 600 : 120) : 0;
  return envInt(name, { fallback, min: 0, max: 1_000_000 });
}

interface Window {
  start: number;
  count: number;
}

const local = () => singleton('api-rate-limit-windows', () => ({ windows: new Map<string, Window>(), swept: 0, warned: 0 }));

/** Count one hit on `key` in the current window; the count after it. */
async function hit(key: string, now: number, windowMs = WINDOW_MS): Promise<number> {
  const windowStart = now - (now % windowMs);
  const state = local();
  const { windows } = state;
  // Sweep stale windows at most once per window, so a flood of distinct keys can't make every hit scan the map.
  if (windows.size > 10_000 && state.swept !== windowStart) {
    state.swept = windowStart;
    for (const [k, w] of windows) if (w.start < windowStart) windows.delete(k);
  }
  const current = windows.get(key);
  // A new key over the cap drops the oldest one (Map order is insertion order).
  if (!current && windows.size >= MAX_LOCAL_KEYS) windows.delete(windows.keys().next().value!);
  const mine = current && current.start === windowStart ? current : { start: windowStart, count: 0 };
  mine.count += 1;
  windows.set(key, mine);
  if (!clusterActive()) return mine.count;
  try {
    return await coordinator().incr(`rl:${key}:${windowStart}`, windowMs * 2);
  } catch (error) {
    if (state.warned !== windowStart) {
      state.warned = windowStart;
      logger.warn('shared API rate limit unavailable, counting in this process', { error: (error as Error).message });
    }
    return mine.count;
  }
}

/**
 * One fixed-window counter for a route that limits itself (the memory playground: 20 a minute a person): counts a hit on `key`
 * and says whether it is within `max` in this window, else after how many seconds the window ends. Shares the store of the
 * API limit (the coordinator in queue mode, else this process).
 */
export async function windowHit(key: string, max: number, windowMs: number, now = Date.now()): Promise<{ allowed: true } | { allowed: false; retryAfter: number }> {
  if ((await hit(`window:${key}`, now, windowMs)) <= max) return { allowed: true };
  return { allowed: false, retryAfter: Math.max(1, Math.ceil((windowMs - (now % windowMs)) / 1000)) };
}

/** How many keys this process counts now (tests). */
export const localKeyCount = (): number => local().windows.size;

/** A 429 to answer with when the request is over its limit; undefined to let it through. */
export async function limitRequest(request: Request, principalId: string | undefined, now = Date.now()): Promise<Response | undefined> {
  let path: string;
  try {
    path = new URL(request.url).pathname;
  } catch {
    return undefined;
  }
  // Hook events have their own per-second limit (harness/limits.ts): a tool-heavy session sends two a call.
  if (EXEMPT.some((prefix) => under(path, prefix)) || HARNESS_HOOK.test(path)) return undefined;
  let bucket: 'api' | 'public';
  let key: string;
  if (principalId) {
    bucket = 'api';
    key = `api:${principalId}`;
  } else {
    const group = PUBLIC_GROUPS.find(([, prefix]) => under(path, prefix))?.[0];
    if (!group) return undefined;
    bucket = 'public';
    key = `public:${group}:${clientAddress(request)}`;
  }
  const limit = apiLimit(bucket);
  if (limit === 0) return undefined;
  if ((await hit(key, now)) <= limit) return undefined;
  countRateLimitRefused(bucket);
  const retryAfter = Math.max(1, Math.ceil((WINDOW_MS - (now % WINDOW_MS)) / 1000));
  return Response.json({ error: 'Too many requests', code: 'rate_limited', retryAfter }, { status: 429, headers: { 'Retry-After': String(retryAfter) } });
}
