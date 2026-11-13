import { afterEach, describe, expect, it } from 'vitest';

// The host's choice of expression backend: realm unless asked, and a refusal only in the production profile.
describe('configureExpressionSandboxFromEnv', () => {
  afterEach(() => {
    delete process.env.LANDFLOW_EXPRESSION_SANDBOX;
    delete process.env.LANDFLOW_PROFILE;
  });

  it('defaults to the realm', async () => {
    const { configureExpressionSandboxFromEnv } = await import('../src/lib/server/expression-sandbox');
    expect(configureExpressionSandboxFromEnv()).toBe('realm');
  });

  it('uses the isolate when it can load, else falls back in development and refuses in production', async () => {
    const { configureExpressionSandboxFromEnv } = await import('../src/lib/server/expression-sandbox');
    const { isolateUnavailable } = await import('@landflow/engine');
    process.env.LANDFLOW_EXPRESSION_SANDBOX = 'isolate';
    process.env.LANDFLOW_PROFILE = 'development';
    // Without --no-node-snapshot the addon does not load here; with it, the isolate is chosen.
    expect(configureExpressionSandboxFromEnv()).toBe(isolateUnavailable() ? 'realm' : 'isolate');
    process.env.LANDFLOW_PROFILE = 'production';
    if (isolateUnavailable()) expect(() => configureExpressionSandboxFromEnv()).toThrow(/isolated-vm cannot load/);
    else expect(configureExpressionSandboxFromEnv()).toBe('isolate');
  });

  it('ignores an unknown value', async () => {
    const { configureExpressionSandboxFromEnv } = await import('../src/lib/server/expression-sandbox');
    process.env.LANDFLOW_EXPRESSION_SANDBOX = 'wasm';
    expect(configureExpressionSandboxFromEnv()).toBe('realm');
  });
});
