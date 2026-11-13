/**
 * The composition root (lib/server/runtime.ts): one service table for both roles, the production-profile boot check,
 * and route modules that wait on `whenReady()` instead of importing the root (the static import closure of http.ts).
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

const src = fileURLToPath(new URL('../src', import.meta.url));

/** Files reachable from `entry` through static `import … from` / `export … from` of relative and `@/` paths (type-only imports skipped). */
function staticClosure(entry: string): Set<string> {
  const resolveSpec = (from: string, spec: string): string | undefined => {
    const base = spec.startsWith('@/') ? join(src, spec.slice(2)) : spec.startsWith('.') ? resolve(dirname(from), spec) : undefined;
    if (!base) return undefined;
    return [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), base].find((candidate) => /\.tsx?$/.test(candidate) && existsSync(candidate));
  };
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(/^\s*(?:import|export)\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm)) {
      const next = resolveSpec(file, match[1] ?? match[2]);
      if (next) queue.push(next);
    }
  }
  return seen;
}

// What bootstrap.ts and worker-main.ts started before this change, in order.
const OLD_WORKER = ['config check', 'database', 'registry', 'broker providers', 'broker connections', 'static plugin seeds', 'kubernetes discovery', 'binary maintenance', 'online evaluations', 'worker cluster'];
const OLD_MAIN = [
  'config check', 'database', 'cluster', 'owner from environment', 'registry', 'broker providers', 'broker connections', 'mcp gateway sync', 'seed workflows', 'data maintenance', 'audit',
  'audit head signing', 'binary maintenance', 'publications', 'project adoption', 'scheduled publishes', 'scheduler', 'mcp trigger subscriptions', 'wait timers', 'trigger buffers',
  'held trigger events', 'recovery', 'retry timers', 'alerts', 'agent triggers', 'evaluation schedules', 'online evaluations', 'usage listeners', 'usage trigger', 'second brain',
  'registry gRPC server', 'static plugin seeds', 'kubernetes discovery', 'startup scan', 'node plugins', 'app webhooks', 'IMAP IDLE',
];

describe('service table', () => {
  it('has unique names and keeps the old boot order for each role', async () => {
    const { SERVICES, servicesFor } = await import('@/lib/server/runtime');
    const names = SERVICES.map((spec) => spec.name);
    expect(new Set(names).size).toBe(names.length);
    // The worker runs the same set; seeds and discovery now follow the evaluations (one shared order), the cluster stays last.
    const worker = servicesFor('worker').map((spec) => spec.name);
    expect([...worker].sort()).toEqual([...OLD_WORKER].sort());
    expect(worker.slice(0, 2)).toEqual(['config check', 'database']);
    expect(worker.at(-1)).toBe('worker cluster');
    expect(servicesFor('main').map((spec) => spec.name)).toEqual(OLD_MAIN);
  });

  it('marks the config check, database and cluster runtime required', async () => {
    const { SERVICES } = await import('@/lib/server/runtime');
    expect(SERVICES.filter((spec) => spec.required).map((spec) => spec.name)).toEqual(['config check', 'database', 'cluster', 'worker cluster']);
  });
});

describe('boot check', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    vi.resetModules();
  });

  it('refuses a production boot with a development secret and names the variable', async () => {
    Object.assign(process.env, { LANDFLOW_PROFILE: 'production', LANDFLOW_CODE_RUNNER_SECRET: 'landflow-dev-only', LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-runtime-')) });
    vi.resetModules();
    const { startRuntime } = await import('@/lib/server/runtime');
    const { ConfigError } = await import('@/lib/server/config');
    const failure = await startRuntime({ role: 'main' }).catch((error) => error);
    expect(failure).toBeInstanceOf(ConfigError);
    expect(failure.message).toContain('LANDFLOW_CODE_RUNNER_SECRET');
    // Every problem is listed, not only the first.
    expect(failure.message).toContain('LANDFLOW_PUBLIC_URL');
    const { bootState } = await import('@/lib/server/lifecycle');
    expect(bootState()).toBe('failed');
  });

  it('boots in the development profile', async () => {
    Object.assign(process.env, {
      LANDFLOW_PROFILE: 'development',
      LANDFLOW_CODE_RUNNER_SECRET: 'landflow-dev-only',
      LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-runtime-')),
      LANDFLOW_REGISTRY_GRPC_PORT: 'off',
      LANDFLOW_SCAN_ON_START: 'false',
      LANDFLOW_PLUGINS: '',
    });
    vi.resetModules();
    const { startRuntime } = await import('@/lib/server/runtime');
    await startRuntime({ role: 'main' });
    const { bootState } = await import('@/lib/server/lifecycle');
    expect(bootState()).toBe('ready');
  });
});

describe('routes wait on readiness', () => {
  it('http.ts and scim/http.ts do not import the composition root', () => {
    for (const file of ['lib/server/http.ts', 'lib/server/scim/http.ts']) {
      expect(readFileSync(join(src, file), 'utf8')).not.toMatch(/from\s+['"][^'"]*bootstrap['"]/);
    }
  });

  it('keeps the static import closure of http.ts small', () => {
    const closure = staticClosure(join(src, 'lib/server/http.ts'));
    const files = [...closure].map((file) => file.slice(src.length + 1));
    expect(files).not.toContain('lib/server/bootstrap.ts');
    expect(files).not.toContain('lib/server/runtime.ts');
    // Measured: 401 files before this change, 72 after (+10%).
    expect(closure.size).toBeLessThan(Math.ceil(72 * 1.1));
  });

  it('handler() boots through the registered bootstrapper, and rejects rather than hangs without one', async () => {
    const { forgetSingleton } = await import('@/lib/server/singleton');
    const { setBootstrapper, whenReady } = await import('@/lib/server/lifecycle');
    const { handler, json } = await import('@/lib/server/http');
    const request = () => new Request('http://localhost/api/health');
    forgetSingleton('lifecycle');
    // Nothing registered: whenReady() rejects with a clear error instead of hanging.
    await expect(whenReady()).rejects.toThrow(/no bootstrapper/);
    const route = handler(async () => json({ ok: true }));
    expect((await route(request())).status).toBe(500);
    let boots = 0;
    const { markBooted } = await import('@/lib/server/lifecycle');
    setBootstrapper(async () => {
      boots++;
      markBooted();
    });
    expect((await route(request())).status).toBe(200);
    expect((await route(request())).status).toBe(200);
    expect(boots).toBe(1);
  });
});

