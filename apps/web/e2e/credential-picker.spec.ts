/**
 * Flow 3: create a credential from the node panel and pick it. An HTTP Request node (Header Auth) is seeded through the
 * API; the flow under test is the panel's credential picker: type a name with no match, Create "<name>", fill the dialog,
 * the combobox shows the new credential picked; Clear empties it and auto-pick leaves it empty; pick it again from the
 * list; run against the `upstream` fake, which answers only a call carrying the credential's header (so a 200 proves the
 * credential reached the request).
 */
import { expect, open, test } from './fixtures';

test('create a credential from the node panel, pick it, clear it, pick it again and run', async ({ signedIn: page, upstream, baseURL, isMobile }) => {
  const origin = baseURL as string;
  // The scratch host is shared by both projects, so each creates its own credential (a name that matches would not offer Create).
  const name = `e2e upstream ${test.info().project.name}`;
  const created = await page.context().request.post(`${origin}/api/workflows`, {
    headers: { origin },
    data: {
      name: 'Credential picker flow',
      nodes: [
        { id: 't', name: 'Manual Trigger', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        {
          id: 'h',
          name: 'HTTP Request',
          type: 'core.httpRequest',
          typeVersion: 1,
          position: [260, 0],
          parameters: { method: 'GET', url: `${upstream.url}/ping`, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' },
        },
      ],
      connections: [{ id: 'e1', type: 'main', source: 't', sourceIndex: 0, target: 'h', targetIndex: 0 }],
    },
  });
  expect(created.status()).toBe(201);
  const { workflow } = (await created.json()) as { workflow: { id: string } };
  await open(page, `/workflows/${workflow.id}`);

  // Open the node's panel: a double click on the canvas, or the step on the phone.
  if (isMobile) await page.getByRole('list', { name: 'Steps' }).getByRole('button', { name: /HTTP Request/ }).click();
  else await page.locator('.react-flow__node[data-id="h"]').dblclick();

  const picker = page.getByRole('combobox', { name: 'Credential for Header Auth' });
  await expect(picker).toBeVisible();

  // No credential matches the name typed: the last option creates one with that name filled in.
  await picker.click();
  await page.getByRole('combobox', { name: 'Search Credential for Header Auth' }).fill(name);
  await page.getByRole('option', { name: `Create “${name}”` }).click();
  const dialog = page.getByRole('dialog', { name: 'New credential' }).or(page.locator('[aria-label="New credential"]'));
  await expect(dialog.getByPlaceholder('My account')).toHaveValue(name);
  await dialog.getByLabel('Header Name').fill('x-api-key');
  await dialog.getByRole('textbox').nth(2).fill(upstream.token); // Header Value: the masked field has no accessible name
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(picker).toContainText(name);

  // Clear takes it off, and the pick rule does not put it back while the panel is open.
  await page.getByRole('button', { name: 'Clear credential' }).click();
  await expect(picker).not.toContainText(name);
  await page.waitForTimeout(1500);
  await expect(picker).not.toContainText(name);

  await picker.click();
  await page.getByRole('option', { name: new RegExp(name) }).click();
  await expect(picker).toContainText(name);

  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Execute workflow' }).click();
  await expect(page.getByText('Workflow succeeded')).toBeVisible();
  const calls = upstream.state().calls;
  expect(calls, 'the upstream was called once, with the credential\'s header').toHaveLength(1);
  expect(calls[0]).toMatchObject({ method: 'GET', path: '/ping', headers: { 'x-api-key': upstream.token } });
  expect(upstream.requests().every((r) => !r.refused)).toBe(true);
});
