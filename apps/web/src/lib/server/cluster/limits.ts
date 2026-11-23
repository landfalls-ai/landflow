/**
 * Queue mode: the limits that must hold across processes, on the coordinator.
 *
 * - `ClusterRateLimiter`: `node.rateLimit` as one sliding window per workflow node for the whole cluster (the engine's
 *   default limiter counts per process). A call over the limit waits its turn, like the in-process limiter, though
 *   turns across processes are not strictly first come, first served.
 * - `exclusive`: a short lock held while a process reads, changes and writes rows another process may change at the
 *   same moment (held trigger events), with the rows read fresh from the database inside it.
 */
import { randomUUID } from 'node:crypto';
import type { NodeRateLimit, RateLimiterLike } from '@landflow/engine';
import { singleton } from '../singleton';
import type { Coordinator } from './coordinator';

const abortError = () => Object.assign(new Error('Execution canceled'), { name: 'AbortError' });

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(1, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class ClusterRateLimiter implements RateLimiterLike {
  constructor(
    private readonly coordinator: () => Coordinator,
    private readonly now: () => number = Date.now,
  ) {}

  async acquire(key: string, limit: NodeRateLimit, signal?: AbortSignal): Promise<number> {
    const max = Math.max(1, Math.floor(Number(limit.limit) || 1));
    const intervalMs = Math.max(1, Number(limit.intervalSeconds) * 1000 || 1000);
    const started = this.now();
    for (;;) {
      if (signal?.aborted) throw abortError();
      const wait = await this.coordinator().rateLimit(`rate:${key}`, max, intervalMs);
      if (wait <= 0) return this.now() - started;
      // A little jitter, so the processes waiting for the same window don't all ask at once.
      await delay(wait + Math.floor(Math.random() * 25), signal);
    }
  }
}

export class LockTimeoutError extends Error {
  constructor(name: string) {
    super(`Timed out waiting for the cluster lock "${name}"`);
    this.name = 'LockTimeoutError';
  }
}

/**
 * Run `fn` while holding the lock `name` (a key with a time to live, so a process that dies holding it frees it after
 * `ttlMs`). Waits up to `waitMs` for it.
 */
export async function exclusive<T>(coordinator: Coordinator, name: string, fn: () => Promise<T>, options: { ttlMs?: number; waitMs?: number } = {}): Promise<T> {
  const ttlMs = options.ttlMs ?? 15_000;
  const waitMs = options.waitMs ?? 10_000;
  const key = `lock:${name}`;
  const token = randomUUID();
  const deadline = Date.now() + waitMs;
  let pause = 5;
  while (!(await coordinator.setIfAbsent(key, token, ttlMs))) {
    if (Date.now() > deadline) throw new LockTimeoutError(name);
    await delay(pause);
    pause = Math.min(100, pause * 2);
  }
  try {
    return await fn();
  } finally {
    await coordinator.deleteIfValue(key, token).catch(() => {});
  }
}

/** The cluster-wide limiter of this process (queue mode), on the running coordinator. */
export function clusterRateLimiter(coordinator: () => Coordinator): ClusterRateLimiter {
  return singleton('cluster-rate-limiter', () => new ClusterRateLimiter(coordinator));
}
