/** Flow 4: open an execution and its Run Trace. The workflow is made and run through the API so the page is what is under test. */
import { expect, open, seedWorkflow, test } from './fixtures';

test('open an execution and its Run Trace', async ({ signedIn: page }) => {
  await open(page, '/runs');
  const { executionId } = await seedWorkflow(page, 'Run trace flow');

  await open(page, `/runs/${executionId}`);
  await expect(page.getByText('Run trace flow').first()).toBeVisible();
  // The Trace tab lists the spans: the trigger and Edit Fields.
  await page.getByRole('tab', { name: 'Trace' }).or(page.getByRole('button', { name: 'Trace', exact: true })).first().click();
  await expect(page.getByText('Edit Fields').first()).toBeVisible();
  await expect(page.getByText('Manual Trigger').first()).toBeVisible();
});
