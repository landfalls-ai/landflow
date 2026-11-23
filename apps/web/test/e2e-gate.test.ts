/**
 * The browser tier (apps/web/e2e) is opt-in: its config throws unless LANDFLOW_INTEGRATION names `browser`, vitest never
 * collects a spec file, and the scratch host refuses the live data directory. No browser starts here.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vitestConfig from '../vitest.config';
import { browserTierEnabled, requireBrowserTier } from '../e2e/gate';
import { dataStamp } from '../e2e/global-setup';
import { assertNoEnvFiles, assertScratchDataDir, freePort, LIVE_DATA_DIR } from '../e2e/scratch-host';

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
    expect(() => assertScratchDataDir(join(tmpdir(), 'landflow-e2e-x'))).not.toThrow();
    // a directory whose name merely starts with two dots is not "outside"
    expect(() => assertScratchDataDir(join(LIVE_DATA_DIR, '..', '..data-like'))).not.toThrow();
  });

  it('asks the OS for a free unprivileged port', async () => {
    expect(await freePort()).toBeGreaterThan(1023);
  });
});

describe('assertNoEnvFiles', () => {
  it('refuses a directory with an .env file, but not .env.example', () => {
    const dir = mkdtempSync(join(tmpdir(), 'landflow-env-'));
    try {
      writeFileSync(join(dir, '.env.example'), 'X=1\n');
      expect(() => assertNoEnvFiles(dir)).not.toThrow();
      writeFileSync(join(dir, '.env.local'), 'DATABASE_URL=nope\n');
      expect(() => assertNoEnvFiles(dir)).toThrow(/\.env\.local/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('dataStamp (the teardown\'s check that apps/web/.data is untouched)', () => {
  it('is "absent" for a missing directory and changes when a file is added, edited or removed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'landflow-stamp-'));
    try {
      expect(dataStamp(join(dir, 'nope'))).toBe('absent');
      const same = dataStamp(dir);
      expect(dataStamp(dir)).toBe(same);
      writeFileSync(join(dir, 'a.db'), 'x');
      const added = dataStamp(dir);
      expect(added).not.toBe(same);
      const old = new Date(Date.now() - 60_000);
      utimesSync(join(dir, 'a.db'), old, old);
      const touched = dataStamp(dir);
      expect(touched).not.toBe(added);
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'sub', 'b'), 'y');
      expect(dataStamp(dir)).not.toBe(touched);
      rmSync(join(dir, 'sub'), { recursive: true });
      expect(dataStamp(dir)).not.toBe(added);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
