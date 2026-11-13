import { afterEach, describe, expect, it, vi } from 'vitest';

// The host's choice of expression backend: realm unless asked, and a refusal only in the production profile.
// isolated-vm is stubbed as missing or present, so both branches run on every machine.
const unavailable = vi.hoisted(() => ({ reason: '' }));
vi.mock('@landflow/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@landflow/engine')>()),
  isolateUnavailable: () => unavailable.reason,
}));

describe('configureExpressionSandboxFromEnv', () => {
  afterEach(() => {
    delete process.env.LANDFLOW_EXPRESSION_SANDBOX;
    delete process.env.LANDFLOW_PROFILE;
    unavailable.reason = '';
  });

  const load = async () => (await import('../src/lib/server/expression-sandbox')).configureExpressionSandboxFromEnv;

  it('defaults to the realm', async () => {
    expect((await load())()).toBe('realm');
  });

  it('uses the isolate when it can load, in either profile', async () => {
    const configure = await load();
    process.env.LANDFLOW_EXPRESSION_SANDBOX = 'isolate';
    process.env.LANDFLOW_PROFILE = 'development';
    expect(configure()).toBe('isolate');
    process.env.LANDFLOW_PROFILE = 'production';
    expect(configure()).toBe('isolate');
  });

  it('falls back to the realm in development when isolated-vm cannot load, and refuses in production', async () => {
    const configure = await load();
    unavailable.reason = 'no addon';
    process.env.LANDFLOW_EXPRESSION_SANDBOX = 'isolate';
    process.env.LANDFLOW_PROFILE = 'development';
    expect(configure()).toBe('realm');
    process.env.LANDFLOW_PROFILE = 'production';
    expect(() => configure()).toThrow(/isolated-vm cannot load/);
  });

  it('uses the realm for an unknown value in development and refuses it in production', async () => {
    const configure = await load();
    process.env.LANDFLOW_EXPRESSION_SANDBOX = 'isolated';
    process.env.LANDFLOW_PROFILE = 'development';
    expect(configure()).toBe('realm');
    process.env.LANDFLOW_PROFILE = 'production';
    expect(() => configure()).toThrow(/must be realm or isolate/);
  });
});
