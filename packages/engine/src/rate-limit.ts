/**
 * Per-node rate limits (`WorkflowNode.rateLimit`): at most `limit` calls per `intervalSeconds`, as a sliding window.
 * A call over the limit waits in a FIFO queue for its turn instead of failing, the way n8n users build it with a
 * Wait node and Loop Over Items, and the way Inngest's throttle queues runs. One limiter is shared by every run in
 * the process, so concurrent executions of a workflow share its nodes' limits.
 */
import type { NodeRateLimit, RateLimiterLike } from './types';

interface Window {
  /** Start times of the calls inside the current window, oldest first. */
  stamps: number[];
  /** The last queued turn: the next one starts after it. */
  tail: Promise<unknown>;
}

const abortError = () => Object.assign(new Error('Execution canceled'), { name: 'AbortError' });

export class RateLimiter implements RateLimiterLike {
  private readonly windows = new Map<string, Window>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Wait for a turn under `key`. Resolves with the milliseconds waited; rejects when `signal` aborts first. */
  acquire(key: string, limit: NodeRateLimit, signal?: AbortSignal): Promise<number> {
    const max = Math.max(1, Math.floor(Number(limit.limit) || 1));
    const intervalMs = Math.max(1, Number(limit.intervalSeconds) * 1000 || 1000);
    let window = this.windows.get(key);
    if (!window) {
      window = { stamps: [], tail: Promise.resolve() };
      this.windows.set(key, window);
    }
    const started = this.now();
    const target = window;
    const turn = target.tail.then(() => this.take(target, max, intervalMs, signal)).then(() => this.now() - started);
    // A canceled turn must not hold up the ones behind it.
    target.tail = turn.catch(() => undefined);
    return turn;
  }

  private async take(window: Window, max: number, intervalMs: number, signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw abortError();
      const now = this.now();
      while (window.stamps.length && window.stamps[0] <= now - intervalMs) window.stamps.shift();
      if (window.stamps.length < max) {
        window.stamps.push(now);
        return;
      }
      await delay(window.stamps[0] + intervalMs - now, signal);
    }
  }

  /** Calls inside the current window per key (tests, diagnostics). */
  usage(key: string): number {
    return this.windows.get(key)?.stamps.length ?? 0;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
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

/** The process-wide limiter (on globalThis, so a reloaded module graph shares it). */
export function sharedRateLimiter(): RateLimiter {
  const holder = globalThis as { __landflowRateLimiter?: RateLimiter };
  return (holder.__landflowRateLimiter ??= new RateLimiter());
}
