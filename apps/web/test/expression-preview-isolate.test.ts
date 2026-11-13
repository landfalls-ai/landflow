/**
 * The preview route evaluates in the isolate when the host chose it: the choice made at boot (here, by the same
 * function the boot calls) reaches a resolver the route creates. Skipped unless LANDFLOW_INTEGRATION=isolate; run it with
 *   NODE_OPTIONS=--no-node-snapshot LANDFLOW_INTEGRATION=isolate npx vitest run test/expression-preview-isolate.test.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const on = (process.env.LANDFLOW_INTEGRATION ?? '').split(',').includes('isolate');
vi.setConfig({ testTimeout: 20_000 });
process.env.LANDFLOW_DATA_DIR = mkdtempSync(join(tmpdir(), 'landflow-preview-isolate-'));
process.env.LANDFLOW_REGISTRY_GRPC_PORT = 'off';
process.env.LANDFLOW_SCAN_ON_START = 'false';
process.env.LANDFLOW_PLUGINS = '';

const preview = async (value: string) => {
  const route = await import('@/app/api/expressions/preview/route');
  const response = await route.POST(new Request('http://localhost/api/expressions/preview', { method: 'POST', body: JSON.stringify({ value }), headers: { 'content-type': 'application/json' } }));
  return (await response.json()) as { ok: boolean; value?: unknown; error?: string };
};

describe.skipIf(!on)('expression preview route on the isolate backend', () => {
  beforeAll(async () => {
    process.env.LANDFLOW_EXPRESSION_SANDBOX = 'isolate';
    const { configureExpressionSandboxFromEnv } = await import('@/lib/server/expression-sandbox');
    expect(configureExpressionSandboxFromEnv()).toBe('isolate');
  });
  afterAll(async () => {
    delete process.env.LANDFLOW_EXPRESSION_SANDBOX;
    const { configureExpressionSandbox } = await import('@landflow/engine');
    configureExpressionSandbox({});
  });

  it('evaluates an expression', async () => {
    expect(await preview('{{ 1 + 1 }}')).toMatchObject({ ok: true, value: 2 });
  });

  it('refuses what only the isolate refuses (the realm answers 16777217)', async () => {
    const result = await preview('{{ "x".repeat(64 * 262144 + 1).length }}');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Invalid string length/);
  });
});
