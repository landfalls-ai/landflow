/**
 * Flow 1: the owner is created on the setup page and signs in. Runs first in each viewport (see the projects in
 * playwright.config.ts). The desktop run finds a fresh instance and creates the owner; the phone run finds the owner and
 * checks that /setup now sends a visitor to the sign-in page, then signs in the same way.
 */
import { expect, open, OWNER, test } from './fixtures';

test('owner setup and sign in', async ({ page, context, baseURL }) => {
  await open(page, '/setup');
  if (page.url().includes('/setup')) {
    await expect(page.getByText('Set up Landflow')).toBeVisible();
    await page.getByLabel('Name').fill(OWNER.name);
    await page.getByLabel('Email').fill(OWNER.email);
    await page.getByLabel('Password').fill(OWNER.password);
    await expect(page.getByLabel('Password')).toHaveValue(OWNER.password);
    await page.getByRole('button', { name: /create owner account/i }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/setup'), { waitUntil: 'networkidle' });
    // Setup signs the owner in; leave, so the sign-in form below is what gets them back.
    await context.clearCookies();
  } else {
    await expect(page).toHaveURL(/\/login/);
  }

  await open(page, '/login');
  await page.getByLabel('Email').fill(OWNER.email);
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { waitUntil: 'networkidle' });

  const me = await page.request.get(`${baseURL}/api/auth/me`);
  expect(((await me.json()) as { user: { email: string; role: string } }).user).toMatchObject({ email: OWNER.email, role: 'owner' });
  // With an owner, the setup page is the sign-in page.
  await context.clearCookies();
  await open(page, '/setup');
  await expect(page).toHaveURL(/\/login/);
});
