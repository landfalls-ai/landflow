/**
 * The browser tier (apps/web/e2e) is opt-in: its config throws unless LANDFLOW_INTEGRATION names `browser`, vitest never
 * collects a spec file, and the scratch host refuses the live data directory. No browser starts here.
 */
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vitestConfig from '../vitest.config';
import { browserTierEnabled, requireBrowserTier } from '../e2e/gate';
import { assertScratchDataDir, freePort, LIVE_DATA_DIR } from '../e2e/scratch-host';

afterEach(() => vi.unstubAllEnvs());

describe('the flag', () => {
  it('is on only when LANDFLOW_INTEGRATION lists browser', () => {
    expect(browserTierEnabled(undefined)).toBe(false);
    expect(browserTierEnabled('')).toBe(false);
    expect(browserTierEnabled('postgres,ollama')).toBe(false);
    expect(browserTierEnabled('browser')).toBe(true);
    expect(browserTierEnabled('postgres, browser')).toBe(true);
  });

  it('stops the config before anything starts when it is off', async () => {
    vi.stubEnv('LANDFLOW_INTEGRATION', '');
    expect(() => requireBrowserTier()).toThrow(/LANDFLOW_INTEGRATION=browser/);
    vi.resetModules();
    await expect(import('../e2e/playwright.config')).rejects.toThrow(/set LANDFLOW_INTEGRATION=browser/);
  });

  it('lets the config load when it is on, with the two viewports and a screenshot on failure', async () => {
    vi.stubEnv('LANDFLOW_INTEGRATION', 'browser');
    vi.resetModules();
    const config = (await import('../e2e/playwright.config')).default;
    const sizes = new Set(config.projects?.map((p) => `${p.use?.viewport?.width}x${p.use?.viewport?.height}`));
    expect([...sizes].sort()).toEqual(['1440x900', '390x844']);
    expect(config.use?.screenshot).toBe('only-on-failure');
  });
});

describe('vitest never collects the browser tier', () => {
  it('has no e2e path or spec pattern in its include', () => {
    const include = vitestConfig.test?.include ?? [];
    expect(include.length).toBeGreaterThan(0);
    for (const pattern of include) {
      expect(pattern).not.toMatch(/e2e|spec/);
      expect(pattern).toMatch(/^(test|src)\/\*\*\/\*\.test\.ts$/);
    }
  });
});

describe('the scratch host', () => {
  it('refuses the live data directory and anything inside it', () => {
    expect(() => assertScratchDataDir(LIVE_DATA_DIR)).toThrow(/live data directory/);
    expect(() => assertScratchDataDir(join(LIVE_DATA_DIR, 'nested'))).toThrow(/live data directory/);
    expect(() => assertScratchDataDir(join(LIVE_DATA_DIR, '..', '.data-other'))).not.toThrow();
  });

  it('asks the OS for a free unprivileged port', async () => {
    expect(await freePort()).toBeGreaterThan(1023);
  });
});
