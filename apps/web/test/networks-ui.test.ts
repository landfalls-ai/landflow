/**
 * C29 T-6: Settings → Networks rendered to static HTML as the other UI tests do: networks as cards with each runner's
 * status, version and last seen, the workflows that use it, the buttons only a built-in admin gets, the docker line and
 * the host address a container should dial, and the tab in the settings page and its group.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Viewer } from '../src/lib/shared/auth';
import { runnerDockerCommand, type NetworkView } from '../src/lib/shared/networks';
import { SETTINGS_GROUPS } from '../src/components/settings/settings-groups';

const root = join(import.meta.dirname, '..', 'src');
const viewerOf = (over: Partial<Viewer> = {}): Viewer => ({ id: 'u1', name: 'Olive', email: 'o@example.test', role: 'owner', sso: false, hasPassword: true, ...over });
const network = (over: Partial<NetworkView> = {}): NetworkView => ({
  id: 'net_1',
  name: 'Office',
  description: 'The office network',
  runners: [
    { id: 'run_1', name: 'office-1', hint: 'a1b2', status: 'online', allowedIps: [], version: '0.1.0', address: '203.0.113.5', lastSeenAt: new Date().toISOString(), createdAt: '2026-11-23T10:00:00.000Z' },
    { id: 'run_2', name: 'old-box', hint: 'zz99', status: 'revoked', allowedIps: ['203.0.113.0/24'], createdAt: '2026-11-22T10:00:00.000Z', revokedAt: new Date().toISOString() },
  ],
  workflows: [{ id: 'wf_1', name: 'Nightly sync' }],
  createdAt: '2026-11-23T10:00:00.000Z',
  ...over,
});

async function render(viewer: Viewer, networks: NetworkView[]) {
  const { ViewerProvider } = await import('../src/components/auth/viewer');
  const { NetworksSettings } = await import('../src/components/settings/networks-settings');
  return renderToStaticMarkup(createElement(ViewerProvider, { viewer, children: createElement(NetworksSettings, { networks }) }));
}

describe('the Networks section', () => {
  it('lists a network with its runners, their status, version and the workflows using it', async () => {
    const out = await render(viewerOf(), [network()]);
    expect(out).toContain('Office');
    expect(out).toContain('The office network');
    expect(out).toContain('office-1');
    expect(out).toContain('Online');
    expect(out).toContain('Version 0.1.0');
    expect(out).toContain('…a1b2');
    expect(out).toContain('Revoked');
    expect(out).toContain('only from 203.0.113.0/24');
    expect(out).toContain('Nightly sync');
    expect(out).toContain('href="/workflows/wf_1"');
    expect(out).toContain('aria-label="Revoke office-1"');
    // A revoked runner has nothing left to revoke.
    expect(out).not.toContain('aria-label="Revoke old-box"');
  });

  it('gives the built-in admin the buttons, and anyone else none', async () => {
    const admin = await render(viewerOf({ role: 'admin' }), [network()]);
    expect(admin).toContain('New network');
    expect(admin).toContain('Register runner');
    expect(admin).toContain('aria-label="Delete Office"');
    const member = await render(viewerOf({ role: 'member', grants: ['settings:manage'] }), [network()]);
    expect(member).not.toContain('New network');
    expect(member).not.toContain('Register runner');
    expect(member).not.toContain('aria-label="Revoke office-1"');
  });

  it('says so when there is nothing yet, and what a network without a runner does', async () => {
    expect(await render(viewerOf(), [])).toContain('No networks yet');
    const out = await render(viewerOf(), [network({ runners: [], workflows: [] })]);
    expect(out).toContain('No runner yet');
    expect(out).toContain('No runner online for network Office');
    expect(out).toContain('No workflow runs in it yet.');
  });

  it('marks a project’s network', async () => {
    const out = await render(viewerOf(), [network({ projectId: 'prj_1', projectName: 'Ops' })]);
    expect(out).toContain('Only Ops');
  });
});

describe('the docker line and the host address', () => {
  it('has the token, the host and the runner’s name, and leaves the allow-list to fill in', async () => {
    const line = runnerDockerCommand('https://landflow.example.com', 'lf_run_TOKEN', 'Office 1');
    expect(line).toContain('--name landflow-runner-office-1');
    expect(line).toContain('LANDFLOW_URL=https://landflow.example.com');
    expect(line).toContain('LANDFLOW_RUNNER_TOKEN=lf_run_TOKEN');
    expect(line).toContain('LANDFLOW_RUNNER_ALLOW=');
  });
  it('a container reaches a local host through host.docker.internal', async () => {
    const { hostUrlForRunner } = await import('../src/components/settings/networks-settings');
    expect(hostUrlForRunner('http://localhost:3190')).toBe('http://host.docker.internal:3190');
    expect(hostUrlForRunner('https://landflow.example.com')).toBe('https://landflow.example.com');
  });
});

describe('the settings page', () => {
  it('has a Networks section for settings managers, in the Infrastructure group', () => {
    const page = readFileSync(join(root, 'app', 'settings', 'page.tsx'), 'utf8');
    expect(page).toMatch(/id: 'networks', label: 'Networks'[^\n]*role: 'settings:manage', admin: true/);
    expect(page).toContain('networks: () => <NetworksSettings />');
    expect(SETTINGS_GROUPS.find((g) => g.id === 'infrastructure')?.sections).toContain('networks');
  });
  it('the component builds no zod schema on the client', () => {
    expect(readFileSync(join(root, 'components', 'settings', 'networks-settings.tsx'), 'utf8')).not.toMatch(/from 'zod'/);
  });
});
