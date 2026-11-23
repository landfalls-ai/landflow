/** Flow 2: create a workflow, add a trigger and a node, run it, see the output. */
import { expect, open, test } from './fixtures';

test('create a workflow, add a node, run it, see the output', async ({ signedIn: page, isMobile }) => {
  await open(page, '/workflows');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Workflow' }).click();
  await page.waitForURL(/\/workflows\/wf_/);
  await page.waitForLoadState('networkidle');

  // The first step is a trigger; the node's panel opens on each add and Escape closes it.
  await page.getByText('Add first step…').click();
  await page.getByPlaceholder(/^Search/).fill('manual');
  await page.getByText('Trigger manually').click();
  await expect(page.getByText('This node emits one empty item')).toBeVisible();
  await page.keyboard.press('Escape');

  // Desktop: the + after the node; phone: "Add a step" in the step list.
  // (The phone shows the steps list; the canvas under it is inert.)
  await (isMobile ? page.getByRole('button', { name: 'Add a step' }) : page.getByTitle('Add a node after this (or drag)')).click();
  await page.getByPlaceholder(/^Search/).fill('edit fields');
  await page.getByText('Edit Fields', { exact: true }).first().click();
  await expect(page.getByText('Fields to Set')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Execute workflow' }).click();
  await expect(page.getByText('Workflow succeeded')).toBeVisible();
  // The phone has no logs panel under the canvas: open the step to see what it output.
  if (isMobile) {
    await page.getByRole('list', { name: 'Steps' }).getByRole('button', { name: /Edit Fields/ }).click();
    await page.getByRole('tab', { name: 'Output' }).or(page.getByRole('button', { name: 'Output' })).first().click();
  }
  // Edit Fields' default field is `greeting = Hello {{ $json.name ?? "world" }}`.
  await expect(page.getByText('Hello world').filter({ visible: true }).first()).toBeVisible();
});
