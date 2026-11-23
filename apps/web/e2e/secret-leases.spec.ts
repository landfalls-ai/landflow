/**
 * Settings → External secrets → Leases (C30): a provider with Dynamic mounts (a fake Vault that issues leases), a Header
 * Auth credential that reads `database/creds/report-reader`, and a run that uses it and then waits an hour, so one lease
 * stays active. The section lists it (run, secret, state), shows no password or lease id, and **Revoke now** removes the
 * credential at the store and the row from the open list. Runs at both viewports.
 */
import { fakeUpstream, type Fake } from '@landflow/test-fakes';
import { fakeVaultLeases, VAULT_LEASES_TOKEN } from '@landflow/test-fakes/vault-leases';
import { expect, open, test } from './fixtures';

test('a waiting run holds a leased secret that the Leases section lists and Revoke now removes', async ({ signedIn: page, baseURL }) => {
  const origin = baseURL as string;
  const headers = { origin };
  const request = page.context().request;
  const project = test.info().project.name.replace(/[^a-z]/g, '');
  const provider = `bao${project}`;
  const bao = fakeVaultLeases();
  const upstream: Fake<unknown> = fakeUpstream() as Fake<unknown>;
  await bao.start();
  await upstream.start();
  try {
    expect(
      (await request.post(`${origin}/api/external-secrets`, { headers, data: { name: provider, kind: 'vault', settings: { url: bao.url, auth: 'token', token: VAULT_LEASES_TOKEN, dynamicMounts: 'database/' } } })).status(),
    ).toBe(201);
    const credential = await request.post(`${origin}/api/credentials`, {
      headers,
      data: { name: `Leased ${project}`, type: 'core.httpHeaderAuth', data: { name: 'x-api-key', value: `{{ $secrets.${provider}['database/creds/report-reader'].password }}` } },
    });
    expect(credential.status()).toBe(201);
    const credentialId = ((await credential.json()) as { credential: { id: string } }).credential.id;
    const created = await request.post(`${origin}/api/workflows`, {
      headers,
      data: {
        name: `Leased secret ${project}`,
        nodes: [
          { id: 't', name: 'Manual Trigger', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
          {
            id: 'h',
            name: 'HTTP Request',
            type: 'core.httpRequest',
            typeVersion: 1,
            position: [260, 0],
            parameters: { method: 'GET', url: `${upstream.url}/ping`, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' },
            credentials: { httpHeaderAuth: { id: credentialId, name: `Leased ${project}` } },
          },
          { id: 'w', name: 'Wait', type: 'core.wait', typeVersion: 2, position: [520, 0], parameters: { resume: 'timeInterval', amount: 1, unit: 'hours' } },
        ],
        connections: [
          { id: 'e1', type: 'main', source: 't', sourceIndex: 0, target: 'h', targetIndex: 0 },
          { id: 'e2', type: 'main', source: 'h', sourceIndex: 0, target: 'w', targetIndex: 0 },
        ],
      },
    });
    expect(created.status()).toBe(201);
    const { workflow } = (await created.json()) as { workflow: { id: string } };
    const stream = await (await request.post(`${origin}/api/workflows/${workflow.id}/run`, { headers, data: {} })).text();
    const executionId = /"executionId":"(ex_[^"]+)"/.exec(stream)?.[1] as string;
    expect(executionId).toBeTruthy();

    // The run reached the upstream with the leased password and waits; the store holds one lease.
    expect(Object.keys(bao.state().active)).toHaveLength(1);
    const issued = bao.state().issued[0];

    await open(page, '/settings#external-secrets');
    const section = page.getByTestId('secret-leases').locator('..');
    await expect(section.getByText('Leases', { exact: true })).toBeVisible();
    await expect(section.getByText('1 open lease')).toBeVisible();
    await expect(section.getByText(`$secrets.${provider}['database/creds/report-reader']`)).toBeVisible();
    await expect(section.getByText('Active', { exact: true })).toBeVisible();
    // Neither the password nor the lease id is on the page.
    const text = await page.locator('body').innerText();
    expect(text).not.toContain(issued.password);
    expect(text).not.toContain(issued.leaseId);

    await section.getByRole('button', { name: 'Revoke now' }).click();
    await expect(section.getByText('No open leases')).toBeVisible();
    expect(bao.state().active).toEqual({});
    expect(bao.state().revoked).toEqual([issued.leaseId]);
    await section.getByRole('tab', { name: 'Ended' }).click();
    await expect(section.getByText('Revoked', { exact: true })).toBeVisible();
  } finally {
    await bao.stop();
    await upstream.stop();
  }
});
