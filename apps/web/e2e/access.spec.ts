/**
 * C35: access requests in the browser at both sizes. The owner sets Access up (one click, no chat model) and adds a
 * by-hand entry; a member, signed in in a second context, asks for it through the form; the owner shortens it to one
 * hour on To decide and approves; both see the grant, the owner marks it done. The e2e host has no plugins, so the
 * entry is the manual one. Names carry the project name so the two sizes don't clash.
 */
import { expect, open, test } from './fixtures';

test('ask, decide with a shorter time, grant, done', async ({ signedIn: page, browser, baseURL }, testInfo) => {
  const size = testInfo.project.name;
  const origin = new URL(baseURL as string).origin;
  const headers = { origin };
  const entry = `Figma seat ${size}`;
  const email = `access-${size}@example.test`;
  const owner = page.context().request;
  const phone = testInfo.project.use.isMobile === true;

  await open(page, '/access');
  if (await page.getByTestId('access-setup-go').isVisible().catch(() => false)) {
    await page.getByTestId('access-setup-go').click();
    await expect(page.getByRole('tab', { name: 'Catalog' })).toBeVisible({ timeout: 60_000 });
  }
  await open(page, '/access?tab=catalog');
  await page.getByTestId('access-new-entry').click();
  await page.getByLabel('Name', { exact: true }).fill(entry);
  await page.getByLabel('System').selectOption({ label: 'Manual (done by hand)' });
  await page.getByLabel('Add to Approvers').selectOption({ index: 1 });
  await page.getByLabel('Add to Owners').selectOption({ index: 1 });
  await page.getByTestId('access-entry-save').click();
  await expect(page.getByText(entry).first()).toBeVisible();

  const invited = await owner.post(`${origin}/api/users/invites`, { headers, data: { email, role: 'member' } });
  expect(invited.status()).toBe(201);
  const token = ((await invited.json()) as { link: string }).link.split('/').pop();
  const member = await browser.newContext({ viewport: page.viewportSize() ?? undefined, isMobile: testInfo.project.use.isMobile, hasTouch: testInfo.project.use.hasTouch, baseURL });
  try {
    expect((await member.request.post(`${origin}/api/auth/invites/${token}`, { headers, data: { name: `Access ${size}`, password: 'e2e-member-password-1' } })).status()).toBe(201);
    const mp = await member.newPage();
    await open(mp, '/access?tab=ask');
    await mp.getByTestId('access-entry').selectOption({ label: `${entry} · Manual (done by hand)` });
    await mp.getByTestId('access-duration-240').click();
    await mp.getByTestId('access-reason').fill('e2e: design review');
    await mp.getByTestId('access-ask-go').click();
    await expect(mp.getByText('Asked. You will see the answer')).toBeVisible({ timeout: 60_000 });
    if (phone) expect(await mp.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

    await open(page, '/access?tab=decide');
    const card = page.getByTestId('confirm-card').first();
    await expect(card).toBeVisible({ timeout: 60_000 });
    await card.getByTestId('confirm-choice').selectOption({ label: '1 h' });
    await card.getByTestId('confirm-approve').click();
    await expect(page.getByTestId('confirm-card')).toHaveCount(0, { timeout: 30_000 });
    await open(page, '/access?tab=grants');
    await expect(page.getByText(`Access ${size}`).first()).toBeVisible({ timeout: 30_000 });
    await page.locator(`xpath=(//*[normalize-space(text())="Access ${size}"]/ancestor::*[.//button[normalize-space()="Done"]])[last()]//button[normalize-space()="Done"]`).first().click();

    await open(mp, '/access?tab=mine');
    await expect(mp.getByText(entry).first()).toBeVisible();
  } finally {
    await member.close();
  }
});
