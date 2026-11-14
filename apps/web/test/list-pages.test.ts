/**
 * The list pages of wave 5 (B34): the Workflows page's one New menu and its last-run column, the credential picker's
 * groups, the data table's + on the header row, the project page's four tabs, the empty-state rule, and the sign-in
 * pages without the welcome sentence. Logic is tested as pure functions and markup with renderToStaticMarkup.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AuthShell, InviteView } from '../src/components/auth/auth-forms';
import { groupCredentialTypes, stripApiSuffix } from '../src/components/credentials/credential-groups';
import { AddColumn } from '../src/components/data-tables/table-view';
import { OVERVIEW_KINDS, PROJECT_TABS, projectTab } from '../src/components/projects/project-tabs';
import { describeLastRun, lastRunByWorkflow, NEW_MENU_ITEMS } from '../src/components/workflows/list-model';
import { LastRun } from '../src/components/workflows/workflows-list';
import { showHeaderAction } from '../src/lib/client/list-page';
import type { CredentialTypeInfo, ExecutionSummary } from '../src/lib/shared/types';

const src = (...parts: string[]) => readFileSync(join(import.meta.dirname, '..', 'src', ...parts), 'utf8');

const run = (workflowId: string, status: ExecutionSummary['status'], startedAt: string) => ({ id: `${workflowId}-${startedAt}`, workflowId, status, startedAt }) as ExecutionSummary;

function type(qualified: string, displayName: string, pluginName: string): CredentialTypeInfo {
  return { type: qualified, pluginId: pluginName, pluginName, available: true, nodeTypes: [], descriptor: { name: qualified, displayName, properties: [] } } as unknown as CredentialTypeInfo;
}

describe('workflows: the New menu', () => {
  it('has Workflow, From template, Import and Folder, in that order', () => {
    expect(NEW_MENU_ITEMS.map((i) => i.label)).toEqual(['Workflow', 'From template', 'Import…', 'Folder']);
    const page = src('components', 'workflows', 'workflows-list.tsx');
    // The menu renders from the constant, so this list is what ships.
    expect(page).toContain('NEW_MENU_ITEMS.map((item)');
    expect(page).not.toMatch(/<MenuItem onClick=\{pick\(/);
    // The step count and the "All workflows" heading are gone.
    expect(page).not.toContain("plural(workflow.nodeCount, 'step')");
    expect(page).not.toContain('All workflows');
  });
});

describe('workflows: last run', () => {
  it('takes each workflow its newest run from a newest-first list', () => {
    const latest = lastRunByWorkflow([run('a', 'error', '2026-01-03T10:00:00Z'), run('b', 'success', '2026-01-02T10:00:00Z'), run('a', 'success', '2026-01-01T10:00:00Z')]);
    expect(latest.get('a')?.status).toBe('error');
    expect(latest.get('b')?.status).toBe('success');
    expect(latest.has('c')).toBe(false);
  });

  it('says the run state, and "Not run yet" without one', () => {
    expect(describeLastRun(run('a', 'error', '2026-01-03T10:00:00Z'))).toMatchObject({ label: 'Failed', tone: 'danger' });
    expect(describeLastRun(run('a', 'success', '2026-01-03T10:00:00Z'))).toMatchObject({ label: 'Succeeded', tone: 'success' });
    expect(describeLastRun(undefined)).toEqual({ label: 'Not run yet', tone: 'muted' });
  });

  it('a row shows the last run state and time', () => {
    const html = renderToStaticMarkup(createElement(LastRun, { run: run('a', 'error', new Date(Date.now() - 3 * 3600_000).toISOString()) }));
    expect(html).toContain('Failed');
    expect(html).toContain('3h ago');
    expect(renderToStaticMarkup(createElement(LastRun, {}))).toContain('Not run yet');
  });

  it('shows the state badge on a phone row too, and nothing for an unknown run', () => {
    const html = renderToStaticMarkup(createElement(LastRun, { run: run('a', 'error', new Date().toISOString()) }));
    expect(html).toContain('data-testid="last-run-phone"');
    expect(html).toContain('md:hidden');
    expect(html).not.toContain('max-sm:hidden');
    expect(renderToStaticMarkup(createElement(LastRun, { unknown: true }))).toBe('');
  });

  it('every empty state carries the New actions its hidden header menu had', () => {
    const page = src('components', 'workflows', 'workflows-list.tsx');
    const root = page.slice(page.indexOf('emptyHere && !current'), page.indexOf('emptyHere && current'));
    const folder = page.slice(page.indexOf('emptyHere && current'));
    for (const label of ['Import', 'Folder', 'Browse templates', 'New workflow']) expect(root).toContain(label);
    for (const label of ['Import', 'New folder', 'From a template', 'New workflow']) expect(folder).toContain(label);
  });
});

describe('credentials: the picker', () => {
  const types = [
    type('messaging.telegramApi', 'Telegram API', 'Messaging'),
    type('messaging.slackApi', 'Slack API', 'Messaging'),
    type('core.httpBasicAuth', 'HTTP Basic Auth', 'Landflow Core'),
    type('github.githubApi', 'GitHub API', 'GitHub'),
    type('core.anthropicApi', 'Anthropic API', 'Landflow Core'),
    type('core.oAuth2Api', 'OAuth2 API', 'Landflow Core'),
  ];

  it('strips the API suffix', () => {
    expect(stripApiSuffix('Telegram API')).toBe('Telegram');
    expect(stripApiSuffix('Slack OAuth2 API')).toBe('Slack OAuth2');
    expect(stripApiSuffix('API')).toBe('API');
    expect(stripApiSuffix('Rapid Basic')).toBe('Rapid Basic');
  });

  it('groups by app, sorted, with the generic group last and no "Landflow Core"', () => {
    const groups = groupCredentialTypes(types);
    expect(groups.map((g) => g.app)).toEqual(['Anthropic', 'GitHub', 'Messaging', 'Generic']);
    expect(groups[3].rows.map((r) => r.label)).toEqual(['HTTP Basic Auth', 'OAuth2']);
    expect(groups[2].rows.map((r) => r.label)).toEqual(['Slack', 'Telegram']);
    expect(JSON.stringify(groups.map((g) => g.app))).not.toContain('Landflow Core');
  });

  it('searches by name, app and description', () => {
    expect(groupCredentialTypes(types, 'tele').flatMap((g) => g.rows.map((r) => r.label))).toEqual(['Telegram']);
    expect(groupCredentialTypes(types, 'messaging').flatMap((g) => g.rows).length).toBe(2);
    expect(groupCredentialTypes(types, 'zzz')).toEqual([]);
  });

  it('has no type grid on the page', () => {
    expect(src('app', 'credentials', 'page.tsx')).not.toContain('Credential types published by plugins');
  });
});

describe('data tables', () => {
  it('the header row carries a + that adds a column; Import and Export CSV are in the menu', () => {
    const html = renderToStaticMarkup(createElement(AddColumn, { onAdd: async () => true }));
    expect(html).toContain('aria-label="Add column"');
    const view = src('components', 'data-tables', 'table-view.tsx');
    expect(view).toContain('<Upload /> Import CSV…');
    expect(view).toContain('<Download /> Export CSV');
    expect(view).not.toContain('<Columns3');
  });
});

describe('projects: four tabs', () => {
  it('has Overview, Members, Settings and Audit log', () => {
    expect(PROJECT_TABS.map((t) => t.label)).toEqual(['Overview', 'Members', 'Settings', 'Audit log']);
  });

  it('maps an old ?tab= link to its new tab', () => {
    for (const old of ['workflows', 'credentials', 'dataTables', 'agents']) expect(projectTab(old)).toBe('overview');
    expect(projectTab('variables')).toBe('settings');
    expect(projectTab('settings')).toBe('settings');
    expect(projectTab('audit')).toBe('audit');
    expect(projectTab('members')).toBe('members');
    expect(projectTab(null)).toBe('overview');
    expect(projectTab('nonsense')).toBe('overview');
  });

  it('the Overview counts link to the global pages filtered to the project', () => {
    expect(OVERVIEW_KINDS.map((k) => k.href('p 1'))).toEqual(['/workflows?project=p%201', '/credentials?project=p%201', '/data-tables?project=p%201', '/agents?project=p%201']);
  });
});

describe('empty states', () => {
  it('the header action hides while the empty state shows its own', () => {
    expect(showHeaderAction(true)).toBe(false);
    expect(showHeaderAction(false)).toBe(true);
  });
});

describe('sign-in pages', () => {
  it('the login page has no welcome sentence', () => {
    expect(src('app', 'login', 'page.tsx')).not.toContain('Welcome back');
    const html = renderToStaticMarkup(createElement(AuthShell, { title: 'Sign in' }, 'form'));
    expect(html).toContain('Sign in');
    expect(html).not.toContain('<p');
  });

  it('an invalid invite shows only the message', () => {
    const html = renderToStaticMarkup(createElement(InviteView, { loadError: 'This invite has expired', loaded: false }, 'FORM'));
    expect(html).toContain('This invite has expired');
    expect(html).not.toMatch(/password/i);
    expect(html).not.toContain('FORM');
    expect(src('app', 'invite', '[token]', 'page.tsx')).not.toContain('Choose your name and a password');
  });
});
