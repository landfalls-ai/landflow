/**
 * The CSP smoke test: with the Content Security Policy enforced, the workflow list and an editor load and no
 * `securitypolicyviolation` fires. The scratch host enforces it (LANDFLOW_CSP=enforce, development profile). With
 * `LANDFLOW_E2E_PROD=1` and a production build (`pnpm --filter @landflow/web build`) global-setup also starts `next start`
 * in the production profile, and the second test runs the same pages there in a context of its own (the cookie jar is
 * shared across ports on localhost, so the two hosts must not share one) and also checks that no inline script lacks a nonce.
 */
import type { Page } from '@playwright/test';
import { expect, OWNER, seedWorkflow, test } from './fixtures';

const violationsOf = (page: Page) => page.evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? []);

async function checkPages(page: Page, origin: string, paths: string[], strictInline: boolean) {
  for (const path of paths) {
    const response = await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
    expect(response?.headers()['content-security-policy'], `${path} is served with an enforced policy`).toMatch(/script-src[^;]*'nonce-/);
    if (strictInline) {
      expect(await page.evaluate(() => document.querySelectorAll('script:not([nonce]):not([src])').length), `${path} has no inline script without a nonce`).toBe(0);
    }
    expect(await violationsOf(page), `${path} violations`).toEqual([]);
  }
}

test('pages load with the CSP enforced and no violation', async ({ signedIn: page, baseURL }) => {
  const { workflowId } = await seedWorkflow(page, 'CSP smoke');
  await checkPages(page, baseURL as string, ['/workflows', `/workflows/${workflowId}`], false);
});

test('the production build loads with the CSP enforced and no violation', async ({ browser, viewport, isMobile, hasTouch }) => {
  const prod = process.env.LANDFLOW_E2E_PROD_URL;
  test.skip(!prod, 'set LANDFLOW_E2E_PROD=1 after `pnpm --filter @landflow/web build` to run the production variant');
  const context = await browser.newContext({ viewport, isMobile, hasTouch });
  try {
    await context.addInitScript(() => {
      const w = window as unknown as { __cspViolations?: string[] };
      w.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (event) => w.__cspViolations?.push(`${event.violatedDirective} ${event.blockedURI}`));
    });
    const login = await context.request.post(`${prod}/api/auth/login`, { data: { email: OWNER.email, password: process.env.LANDFLOW_E2E_PROD_PASSWORD }, headers: { origin: prod as string } });
    expect(login.status()).toBe(200);
    const page = await context.newPage();
    const { workflowId } = await seedWorkflow(page, 'CSP smoke (production)', prod);
    await checkPages(page, prod as string, ['/workflows', `/workflows/${workflowId}`], true);
  } finally {
    await context.close();
  }
});
