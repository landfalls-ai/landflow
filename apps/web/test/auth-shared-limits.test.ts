/**
 * Sign-in rate limits in queue mode (lib/server/auth/rate-limit.ts AttemptLimiter): the counts live in the coordinator
 * (Valkey), so a second main sees the failures the first one counted; reset clears them; a coordinator that fails
 * leaves the main's own count in force. Regular mode counts in memory.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { AttemptLimiter } from '@/lib/server/auth/rate-limit';
import { MemoryCoordinator, MemoryHub } from '@/lib/server/cluster/memory';
import { clusterState } from '@/lib/server/cluster/state';

const state = clusterState();
const saved = { started: state.started, mode: state.config.mode, coordinator: state.coordinator };
afterEach(() => {
  state.started = saved.started;
  state.config = { ...state.config, mode: saved.mode };
  state.coordinator = saved.coordinator;
});

function queueMode(coordinator: MemoryCoordinator) {
  state.config = { ...state.config, mode: 'queue' };
  state.started = true;
  state.coordinator = coordinator;
}

describe('shared sign-in limits', () => {
  it('counts across mains: a failure on one blocks the same key on another', async () => {
    const hub = new MemoryHub(() => Date.now());
    queueMode(new MemoryCoordinator(hub));
    const mainA = new AttemptLimiter('email', 3, 60_000);
    const mainB = new AttemptLimiter('email', 3, 60_000); // another process: its own memory, the same Valkey
    for (let i = 0; i < 3; i++) await mainA.hit('a@example.com');
    const blocked = await mainB.check('a@example.com');
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(50);
    expect((await mainB.check('b@example.com')).ok).toBe(true);
    await mainB.reset('a@example.com');
    expect((await mainA.check('a@example.com')).ok).toBe(true);
  });

  it('counts in memory outside queue mode', async () => {
    const limiter = new AttemptLimiter('ip', 2, 60_000);
    await limiter.hit('x');
    await limiter.hit('x');
    expect((await limiter.check('x')).ok).toBe(false);
    expect((await limiter.check('y')).ok).toBe(true);
  });

  it('keeps counting in the process when the coordinator fails', async () => {
    const broken = new MemoryCoordinator(new MemoryHub(() => Date.now()));
    broken.incr = async () => {
      throw new Error('valkey down');
    };
    broken.get = async () => {
      throw new Error('valkey down');
    };
    queueMode(broken);
    const limiter = new AttemptLimiter('form', 2, 60_000);
    await limiter.hit('z');
    await limiter.hit('z');
    expect((await limiter.check('z')).ok).toBe(false);
  });
});
