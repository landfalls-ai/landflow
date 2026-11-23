/** Flow 5: Settings -> API keys: create a key (shown once), see it listed, revoke it. */
import { expect, open, test } from './fixtures';

test('create an API key, see it once, revoke it', async ({ signedIn: page }) => {
  await open(page, '/settings#api-keys');
  await page.getByRole('button', { name: 'New API key' }).click();
  await page.getByLabel('Key name').fill('e2e key');
  await page.getByRole('button', { name: 'Create key' }).click();

  const key = page.getByTestId('new-api-key');
  await expect(key).toContainText(/^lf_/);
  await expect(page.getByText('Copy “e2e key” now.')).toBeVisible();
  await expect(page.getByText('e2e key', { exact: true })).toBeVisible();

  // It is shown once: dismiss it and it is gone, only the hint stays.
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await expect(key).toHaveCount(0);

  await page.getByRole('button', { name: 'Revoke e2e key' }).click();
  await page.getByRole('alertdialog', { name: 'Revoke e2e key?' }).getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByText('e2e key', { exact: true })).toHaveCount(0);
});
