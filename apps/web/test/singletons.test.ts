/**
 * Process-wide state (lib/server/singleton.ts): one way to hold it, one owner per key, the marketplace sync guard shared
 * by every module graph, and the store's execution-finished event with the reactions registered in both roles.
 */
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { ExecutionRecord } from '@/lib/shared/types';

vi.setConfig({ testTimeout: 30_000 });

const root = fileURLToPath(new URL('../src/lib/server', import.meta.url));
const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : name.endsWith('.ts') ? [join(dir, name)] : []));
const sources = files(root).map((file) => ({ file, text: readFileSync(file, 'utf8') }));
const code = (text: string) => text.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

describe('one way to hold process-wide state', () => {
  it('nothing but singleton.ts touches globalThis.__landflow or declares a __landflow* holder', () => {
    const offenders = sources.filter(({ file, text }) => !file.endsWith('/singleton.ts') && /__landflow/.test(code(text))).map(({ file }) => file.slice(root.length));
    expect(offenders).toEqual([]);
  });

  it('declares no singleton key literal in two files; shared keys come from singletonKeys', () => {
    const owners = new Map<string, Set<string>>();
    for (const { file, text } of sources) {
      if (file.endsWith('/singleton.ts')) continue;
      for (const match of code(text).matchAll(/\bsingleton(?:<[^>]*>)?\(\s*'([^']+)'/g)) owners.set(match[1], (owners.get(match[1]) ?? new Set()).add(file.slice(root.length)));
    }
    const shared = [...owners].filter(([, where]) => where.size > 1).map(([key, where]) => `${key}: ${[...where].join(', ')}`);
    expect(shared).toEqual([]);
  });

  it('resetSingleton makes the next singleton() create again, and forgetSingleton is the same function', async () => {
    const { forgetSingleton, resetSingleton, singleton } = await import('@/lib/server/singleton');
    let made = 0;
    const first = singleton('test-reset', () => ({ n: ++made }));
    expect(singleton('test-reset', () => ({ n: ++made }))).toBe(first);
    resetSingleton('test-reset');
    expect(singleton('test-reset', () => ({ n: ++made })).n).toBe(2);
    expect(forgetSingleton).toBe(resetSingleton);
    resetSingleton('test-reset');
  });

  it('the marketplace sync guard is shared by two module graphs', async () => {
    const { singleton, resetSingleton } = await import('@/lib/server/singleton');
    resetSingleton('marketplace-sync');
    vi.resetModules();
    const first = await import('@/lib/server/marketplace/service');
    vi.resetModules();
    const second = await import('@/lib/server/marketplace/service');
    expect(first).not.toBe(second);
    // The guard both graphs see is the one in the shared map.
    const guard = singleton('marketplace-sync', () => ({ running: undefined as Promise<void> | undefined, again: false }));
    let release!: () => void;
    guard.running = new Promise<void>((done) => (release = done));
    // A second graph's sync while one runs waits for it (and asks for another pass) instead of starting a concurrent one.
    const waiting = second.marketplace.syncNodePlugins();
    expect(guard.again).toBe(true);
    release();
    await waiting;
    guard.running = undefined;
    resetSingleton('marketplace-sync');
  });
});

describe('the retention variables', () => {
  it('read the LANDFLOW_ names, with the old names as fallbacks', async () => {
    const keep = { a: process.env.USAGE_RETENTION_DAYS, b: process.env.LANDFLOW_USAGE_RETENTION_DAYS };
    delete process.env.LANDFLOW_USAGE_RETENTION_DAYS;
    process.env.USAGE_RETENTION_DAYS = '30';
    const { rawRetentionDays } = await import('@/lib/server/usage/query');
    expect(rawRetentionDays()).toBe(30);
    process.env.LANDFLOW_USAGE_RETENTION_DAYS = '7';
    expect(rawRetentionDays()).toBe(7);
    for (const [name, value] of [['USAGE_RETENTION_DAYS', keep.a], ['LANDFLOW_USAGE_RETENTION_DAYS', keep.b]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    const text = readFileSync(join(root, 'ai-usage/index.ts'), 'utf8');
    expect(text).toMatch(/LANDFLOW_AI_USAGE_RETENTION_DAYS \?\? process\.env\.AI_USAGE_RETENTION_DAYS/);
  });
});

describe('execution reactions', () => {
  const record = (id: string, status: ExecutionRecord['status']): ExecutionRecord => {
    const at = new Date().toISOString();
    return { executionId: id, workflowId: 'wf_react', workflowName: 'React', mode: 'trigger', status, startedAt: at, ...(status === 'running' ? {} : { finishedAt: at }), durationMs: 1, runData: {}, executionOrder: [] };
  };

  it('store.ts imports neither insights, the usage ledger nor settings (statically, through the closure of its imports)', () => {
    const resolveSpec = (from: string, spec: string) => {
      const base = spec.startsWith('@/') ? join(root, '..', '..', spec.slice(2)) : resolve(dirname(from), spec);
      return [`${base}.ts`, join(base, 'index.ts')].find((candidate) => sources.some((s) => s.file === candidate));
    };
    const seen = new Set<string>();
    const queue = [join(root, 'store.ts')];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
        const next = resolveSpec(file, match[1]);
        if (next) queue.push(next);
      }
    }
    const reached = [...seen].map((file) => file.slice(root.length));
    for (const banned of ['/insights.ts', '/settings.ts', '/usage/ledger.ts']) expect(reached).not.toContain(banned);
  });

  it('fire once per finished run, not for running or backtest saves; registering twice does not double them', async () => {
    process.env.LANDFLOW_DATA_DIR = mkdtempSync(join(tmpdir(), 'landflow-singletons-'));
    vi.resetModules();
    const { resetSingleton } = await import('@/lib/server/singleton');
    for (const key of ['store', 'store-execution-finished', 'execution-reactions']) resetSingleton(key);
    const { store, onExecutionFinished } = await import('@/lib/server/store');
    const { ensureExecutionReactions } = await import('@/lib/server/execution-reactions');
    const { inBacktest } = await import('@/lib/server/brain/backtest-scope');
    const { database } = await import('@/lib/server/db');
    const seen: string[] = [];
    const off = onExecutionFinished(({ record: saved }) => seen.push(saved.executionId));
    ensureExecutionReactions();
    ensureExecutionReactions();
    const usageRows = () => database().get<{ n: number }>("SELECT COUNT(*) AS n FROM usage_events WHERE kind = 'run.finished'")?.n ?? 0;
    const before = usageRows();
    store.saveExecution(record('ex_react_run', 'running'));
    inBacktest({ asOf: Date.now(), quiet: 1 }, () => store.saveExecution(record('ex_react_bt', 'success')));
    expect(seen).toEqual([]);
    expect(usageRows()).toBe(before);
    store.saveExecution(record('ex_react_done', 'success'));
    expect(seen).toEqual(['ex_react_done']);
    expect(usageRows()).toBe(before + 1);
    off();
    store.saveExecution(record('ex_react_after', 'success'));
    expect(seen).toEqual(['ex_react_done']);
  });

  it('are registered by the boot of both roles', async () => {
    Object.assign(process.env, { LANDFLOW_PROFILE: 'development', LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-singletons-')) });
    for (const role of ['main', 'worker'] as const) {
      vi.resetModules();
      const { resetSingleton } = await import('@/lib/server/singleton');
      resetSingleton('execution-reactions');
      resetSingleton('lifecycle');
      resetSingleton('bootstrap');
      resetSingleton('runtime:worker');
      const { SERVICES, startRuntime } = await import('@/lib/server/runtime');
      SERVICES.length = 0; // only the reactions, which come before the table
      await startRuntime({ role });
      const { singleton } = await import('@/lib/server/singleton');
      let registered = true;
      singleton('execution-reactions', () => ((registered = false), true));
      expect(registered, `the ${role} boot registers the reactions`).toBe(true);
      resetSingleton('execution-reactions');
    }
  });
});
