/**
 * Playwright config for the browser tier (docs/development.md, "Browser tests"). Two projects, one scratch host
 * (global-setup.ts), this machine's Chrome (never a downloaded browser), a screenshot and a trace on failure.
 * Opt-in: without `LANDFLOW_INTEGRATION=browser` this file throws before anything starts.
 */
import { defineConfig } from '@playwright/test';
import { requireBrowserTier } from './gate';

requireBrowserTier();

/** `chrome` (this machine's Chrome) unless `LANDFLOW_E2E_CHANNEL=chromium` after `npx playwright install chromium`. */
const channel = process.env.LANDFLOW_E2E_CHANNEL ?? 'chrome';
const headed = Boolean(process.env.LANDFLOW_E2E_HEADED);

const SETUP = /owner-setup\.spec\.ts$/;
const desktop = { viewport: { width: 1440, height: 900 } };
const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: './test-results',
  reporter: [['list'], ['html', { open: 'never', outputFolder: './report' }]],
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  // One host, one owner: the specs run one after another.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  use: {
    channel: channel === 'chromium' ? undefined : channel,
    headless: !headed,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 30_000,
    navigationTimeout: 90_000,
    // The Chrome window of a headed run opens at the viewport's size.
  },
  // Every spec runs at both sizes. The owner-setup flow goes first at each (it makes the owner, then signs in as it), so
  // each size is two projects in a chain: <size>-setup, then the rest of the specs. The phone chain waits for the desktop one.
  projects: [
    { name: 'desktop-setup', testMatch: SETUP, use: desktop },
    { name: 'desktop', testIgnore: SETUP, dependencies: ['desktop-setup'], use: desktop },
    { name: 'phone-setup', testMatch: SETUP, dependencies: ['desktop'], use: phone },
    { name: 'phone', testIgnore: SETUP, dependencies: ['phone-setup'], use: phone },
  ],
});
