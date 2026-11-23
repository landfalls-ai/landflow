/**
 * C32: custom roles in the browser at both sizes. The owner creates "Platform" (Manage plugins and Manage MCP) in
 * Settings → Users, gives it to a member through the row's select, and the member, signed in in a second browser
 * context (a second profile), sees MCP and no Users in Settings; the plugins gate lets their request through (400 for an
 * empty body, not 403) and the users gate refuses it (403). The owner then takes Manage MCP away and the member's next
 * MCP request is 403 with no sign-out. The role name carries the project name so the two sizes don't clash.
 */
import { expect, open, test } from './fixtures';

test('a Platform role gives a member plugins and MCP, not users', async ({ signedIn: page, browser, baseURL }, testInfo) => {
  const size = testInfo.project.name;
  const origin = new URL(baseURL as string).origin;
  const headers = { origin };
  const roleName = `Platform ${size}`;
  const email = `platform-${size}@example.test`;
  const owner = page.context().request;

  // 1. The owner makes the role.
  await open(page, '/settings#users');
  await page.getByRole('button', { name: 'New role' }).click();
  await page.locator('#role-name').fill(roleName);
  await page.getByLabel('Manage plugins', { exact: true }).check();
  await page.getByLabel('Manage MCP', { exact: true }).check();
  // The owner may grant Manage users; nobody may grant Manage projects.
  await expect(page.getByLabel('Manage users', { exact: true })).toBeEnabled();
  await expect(page.getByLabel('Manage projects', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Create role' }).click();
  await expect(page.getByRole('button', { name: `Edit ${roleName}` })).toBeVisible();

  // 2. A member, signed in in a second context; the owner gives them the role.
  const invited = await owner.post(`${origin}/api/users/invites`, { headers, data: { email, role: 'member' } });
  expect(invited.status()).toBe(201);
  const token = ((await invited.json()) as { link: string }).link.split('/').pop();
  const member = await browser.newContext({ viewport: page.viewportSize() ?? undefined, isMobile: testInfo.project.use.isMobile, hasTouch: testInfo.project.use.hasTouch, baseURL });
  try {
    expect((await member.request.post(`${origin}/api/auth/invites/${token}`, { headers, data: { name: `Platform ${size}`, password: 'e2e-member-password-1' } })).status()).toBe(201);
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByLabel(`Custom role of Platform ${size}`).selectOption({ label: roleName });
    await expect(page.getByText(/now holds/)).toBeVisible();

    // 3. The member sees MCP and no Users; the gates answer as the role says.
    const mp = await member.newPage();
    await open(mp, '/settings');
    await expect(mp.getByText('MCP', { exact: true }).first()).toBeVisible();
    await expect(mp.getByText('Users', { exact: true })).toHaveCount(0);
    expect((await member.request.post(`${origin}/api/marketplaces`, { headers, data: { input: '' } })).status()).toBe(400);
    expect((await member.request.post(`${origin}/api/users/invites`, { headers, data: { email: 'x@example.test' } })).status()).toBe(403);
    expect((await member.request.get(`${origin}/api/settings/mcp`)).status()).toBe(200);

    // 4. Taking Manage MCP away shows on the member's next request.
    await page.getByRole('button', { name: `Edit ${roleName}` }).click();
    await page.getByLabel('Manage MCP', { exact: true }).uncheck();
    await page.getByRole('button', { name: 'Save role' }).click();
    await expect(page.getByText(`Saved ${roleName}`)).toBeVisible();
    expect((await member.request.get(`${origin}/api/settings/mcp`)).status()).toBe(403);
  } finally {
    await member.close();
  }
});
