import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A fresh lifecycle per test: forget the singleton so steps and the draining flag don't leak between tests.
async function fresh() {
  const { forgetSingleton } = await import('../src/lib/server/singleton');
  forgetSingleton('lifecycle');
  return import('../src/lib/server/lifecycle');
}

afterEach(async () => {
  const { forgetSingleton } = await import('../src/lib/server/singleton');
  forgetSingleton('lifecycle');
});

describe('shutdown registry', () => {
  it('runs phases in order and steps of a phase one after another', async () => {
    const lc = await fresh();
    const order: string[] = [];
    lc.onShutdown('t', () => void order.push('t'), 'telemetry');
    lc.onShutdown('s1', () => void order.push('s1'), 'storage');
    lc.onShutdown('i', () => void order.push('i'), 'intake');
    lc.onShutdown('c', () => void order.push('c'), 'cluster');
    lc.onShutdown('r', () => void order.push('r'), 'runs');
    lc.onShutdown('v1', async () => { await new Promise((r) => setTimeout(r, 20)); order.push('v1'); }, 'services');
    lc.onShutdown('v2', () => void order.push('v2'), 'services');
    await lc.shutdown('test');
    expect(order).toEqual(['i', 'v1', 'v2', 'r', 'c', 's1', 't']);
  });

  it('a timed-out or throwing step does not block later steps', async () => {
    const lc = await fresh();
    const order: string[] = [];
    lc.onShutdown('hang', () => new Promise(() => {}), 'services', { timeoutMs: 30 });
    lc.onShutdown('boom', () => { throw new Error('x'); }, 'services');
    lc.onShutdown('after', () => void order.push('after'), 'storage');
    await lc.shutdown('test');
    expect(order).toEqual(['after']);
  });

  it('is idempotent, sets draining first, and unregister removes a step', async () => {
    const lc = await fresh();
    const fn = vi.fn();
    const off = lc.onShutdown('a', fn, 'services');
    off();
    const first = lc.shutdown('one');
    expect(lc.isDraining()).toBe(true);
    expect(lc.shutdown('two')).toBe(first);
    await first;
    expect(fn).not.toHaveBeenCalled();
  });

  it('registering a name again replaces the entry', async () => {
    const lc = await fresh();
    const a = vi.fn();
    const b = vi.fn();
    lc.onShutdown('same', a, 'services');
    lc.onShutdown('same', b, 'services');
    await lc.shutdown('test');
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('waits for requests in flight in the intake phase', async () => {
    const lc = await fresh();
    let release!: () => void;
    const req = lc.trackRequest(() => new Promise<void>((r) => (release = r)));
    const order: string[] = [];
    lc.onShutdown('svc', () => void order.push('svc'), 'services');
    const done = lc.shutdown('test');
    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual([]);
    release();
    await req;
    await done;
    expect(order).toEqual(['svc']);
  });
});

describe('draining', () => {
  it('answers 503 with Retry-After except under /api/health', async () => {
    const lc = await fresh();
    const { handler, json } = await import('../src/lib/server/http');
    const route = handler(async () => json({ ok: true }));
    await lc.shutdown('test');
    const blocked = await route(new Request('http://localhost/api/workflows'));
    expect(blocked.status).toBe(503);
    expect(blocked.headers.get('Retry-After')).toBe('5');
    const health = await route(new Request('http://localhost/api/health'));
    expect(health.status).toBe(200);
  });
});

describe('shutdown reserve', () => {
  it('a hanging runs step still lets a slow storage and telemetry step finish', async () => {
    const lc = await fresh();
    const done: string[] = [];
    lc.onShutdown('runs', () => new Promise(() => {}), 'runs');
    lc.onShutdown('db', async () => { await new Promise((r) => setTimeout(r, 50)); done.push('db'); }, 'storage');
    lc.onShutdown('tel', async () => { await new Promise((r) => setTimeout(r, 50)); done.push('tel'); }, 'telemetry');
    await lc.shutdown('test', { deadlineMs: 1000 });
    expect(done).toEqual(['db', 'tel']);
  });
});

describe('boot failure policy', () => {
  it('a synchronous SQLite failure clears the cached promise too', async () => {
    const saved = { ...process.env };
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      const dir = mkdtempSync(join(tmpdir(), 'landflow-lifecycle-'));
      writeFileSync(join(dir, 'landflow.db'), 'this is not a database'.repeat(200));
      process.env.LANDFLOW_DATA_DIR = dir;
      delete process.env.LANDFLOW_DB;
      vi.resetModules();
      const { forgetSingleton } = await import('../src/lib/server/singleton');
      forgetSingleton('bootstrap');
      forgetSingleton('database');
      const { ensureBootstrapped } = await import('../src/lib/server/bootstrap');
      const first = ensureBootstrapped();
      await expect(first).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 5));
      expect(ensureBootstrapped()).not.toBe(first);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      const { forgetSingleton } = await import('../src/lib/server/singleton');
      forgetSingleton('bootstrap');
      forgetSingleton('database');
      forgetSingleton('lifecycle');
      exit.mockRestore();
      vi.resetModules();
    }
  });

  it('a required failure clears the cached promise so a later call retries', async () => {
    const saved = { ...process.env };
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      process.env.LANDFLOW_DATA_DIR = mkdtempSync(join(tmpdir(), 'landflow-lifecycle-'));
      process.env.LANDFLOW_DB = 'postgres';
      delete process.env.DATABASE_URL;
      vi.resetModules();
      const { forgetSingleton } = await import('../src/lib/server/singleton');
      forgetSingleton('bootstrap');
      forgetSingleton('database');
      const { ensureBootstrapped } = await import('../src/lib/server/bootstrap');
      const lc = await import('../src/lib/server/lifecycle');
      const first = ensureBootstrapped();
      await expect(first).rejects.toThrow();
      expect(lc.bootState()).toBe('failed');
      const second = ensureBootstrapped();
      expect(second).not.toBe(first);
      await expect(second).rejects.toThrow();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      const { forgetSingleton } = await import('../src/lib/server/singleton');
      forgetSingleton('bootstrap');
      forgetSingleton('database');
      forgetSingleton('lifecycle');
      exit.mockRestore();
      vi.resetModules();
    }
  });
});

describe('leaderService in regular mode', () => {
  it('does not throw for a sync throw or a rejected start', async () => {
    const { leaderService, stopLeaderServices } = await import('../src/lib/server/cluster');
    expect(() => leaderService('sync boom', () => { throw new Error('a'); })).not.toThrow();
    expect(() => leaderService('async boom', () => Promise.reject(new Error('b')))).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    await stopLeaderServices();
  });
});

describe('process handlers', () => {
  it('logs and counts an unhandled rejection', async () => {
    const lc = await fresh();
    const { logger } = await import('../src/lib/server/telemetry/logger');
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    expect(() => lc.onUnhandledRejection(new Error('nope'))).not.toThrow();
    expect(spy).toHaveBeenCalledWith('unhandled rejection', expect.objectContaining({ error: expect.any(Error) }));
    spy.mockRestore();
  });

  it('adds no signal listeners under vitest', async () => {
    const lc = await fresh();
    const count = () => process.listenerCount('SIGTERM') + process.listenerCount('SIGINT') + process.listenerCount('unhandledRejection');
    const before = count();
    lc.installProcessHandlers({ role: 'main' });
    expect(count()).toBe(before);
  });
});
