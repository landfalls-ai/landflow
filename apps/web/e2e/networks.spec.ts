/**
 * C29: Settings → Networks in the browser at both sizes. The owner creates a network, registers a runner (the token shows
 * once, with the docker line), sees it listed offline with its hint and not the token, the token is gone after a reload,
 * a runner that polls turns online (a real poll with the token, over the API), and Revoke (after its confirm) makes the
 * token refuse. Names carry the project name so the two sizes don't clash.
 */
import { expect, open, test } from './fixtures';

test('a network: register a runner, see it online, revoke it', async ({ signedIn: page, baseURL }, testInfo) => {
  const size = testInfo.project.name;
  const origin = new URL(baseURL as string).origin;
  const name = `Office ${size}`;

  await open(page, '/settings#networks');
  await page.getByRole('button', { name: 'New network' }).click();
  await page.locator('#network-name').fill(name);
  await page.getByRole('button', { name: 'Create network' }).click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Register runner' }).first().click();
  await page.locator('#runner-name').fill('office-1');
  await page.getByRole('button', { name: 'Register runner', exact: true }).last().click();
  const token = (await page.getByTestId('new-runner-token').textContent()) ?? '';
  expect(token).toMatch(/^lf_run_[A-Za-z0-9]{32}$/);
  await expect(page.getByText(/docker run/)).toBeVisible();
  await expect(page.getByText('Offline')).toBeVisible();

  // A poll with the token reaches the host: the runner turns online without a reload.
  const poll = await page.context().request.post(`${origin}/api/runner/v1/poll`, { headers: { authorization: `Bearer ${token}` }, data: { version: '0.0.0-e2e', max: 0 } });
  expect(poll.status()).toBe(204);
  await expect(page.getByText('Online')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Version 0.0.0-e2e')).toBeVisible();

  // Once only: a reload shows the runner by its hint and never the token.
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.getByTestId('new-runner-token')).toHaveCount(0);
  await expect(page.getByText(`…${token.slice(-4)}`)).toBeVisible();

  await page.getByRole('button', { name: 'Revoke office-1' }).click();
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(page.getByText('Revoked', { exact: true })).toBeVisible();
  const refused = await page.context().request.post(`${origin}/api/runner/v1/poll`, { headers: { authorization: `Bearer ${token}` }, data: {} });
  expect(refused.status()).toBe(401);
});
