/** The rail's nine places, the section tabs and the user menu's new rows (made-up plugin ids and paths only). */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { offlineDot, RAIL_ITEMS, railActive, SECTION_GROUPS, showReconnecting, stripGroup, visibleTabs } from '../src/components/shell/section-nav';

vi.mock('../src/components/auth/viewer', () => ({
  useViewer: () => ({ id: 'u1', name: 'Test Owner', email: 'owner@landflow.test', role: 'owner', sso: false }),
  initials: () => 'TO',
  signOut: async () => {},
}));
vi.mock('next/link', () => ({ default: (p: { href: string; children: unknown; className?: string }) => createElement('a', { href: p.href, className: p.className }, p.children as never) }));

const activeItem = (pathname: string) => RAIL_ITEMS.find((i) => railActive(i.href, pathname))?.label;

describe('the rail', () => {
  it('has exactly nine items, in order', () => {
    expect(RAIL_ITEMS.map((i) => i.label)).toEqual(['Home', 'Workflows', 'Runs', 'Agents', 'Brain', 'Data tables', 'Credentials', 'Plugins', 'Settings']);
  });

  it('marks the group item for every page of its group', () => {
    expect(activeItem('/')).toBe('Home');
    expect(activeItem('/workflows')).toBe('Workflows');
    expect(activeItem('/workflows/wf_1')).toBe('Workflows');
    expect(activeItem('/templates')).toBe('Workflows');
    expect(activeItem('/runbooks')).toBe('Workflows');
    expect(activeItem('/executions')).toBe('Runs');
    expect(activeItem('/insights')).toBe('Runs');
    expect(activeItem('/runs')).toBe('Runs');
    expect(activeItem('/runs/ex_1')).toBe('Runs');
    expect(activeItem('/runs/compare')).toBe('Runs');
    expect(activeItem('/plugins')).toBe('Plugins');
    expect(activeItem('/marketplace')).toBe('Plugins');
    expect(activeItem('/developers')).toBe('Plugins');
    expect(activeItem('/settings')).toBe('Settings');
    expect(activeItem('/data-tables')).toBe('Data tables');
  });
});

describe('the section tabs', () => {
  it('lists each group', () => {
    expect(SECTION_GROUPS.workflows.map((t) => t.href)).toEqual(['/workflows', '/templates', '/runbooks']);
    expect(SECTION_GROUPS.runs.map((t) => t.href)).toEqual(['/executions', '/insights', '/runs']);
    expect(SECTION_GROUPS.plugins.map((t) => t.href)).toEqual(['/plugins', '/marketplace', '/developers']);
  });

  it('shows a strip on list pages and not on the editor, a run or a compare', () => {
    expect(stripGroup('/workflows')).toBe('workflows');
    expect(stripGroup('/templates')).toBe('workflows');
    expect(stripGroup('/insights')).toBe('runs');
    expect(stripGroup('/executions')).toBe('runs');
    expect(stripGroup('/runs')).toBe('runs');
    expect(stripGroup('/developers')).toBe('plugins');
    expect(stripGroup('/marketplace/flows/a/b')).toBeUndefined();
    expect(stripGroup('/workflows/wf_1')).toBeUndefined();
    expect(stripGroup('/runs/ex_1')).toBeUndefined();
    expect(stripGroup('/runs/compare')).toBeUndefined();
    expect(stripGroup('/agents')).toBeUndefined();
  });

  it('shows Runbooks only with the landfall plugin', () => {
    expect(visibleTabs('workflows', []).map((t) => t.label)).toEqual(['Workflows', 'Templates']);
    expect(visibleTabs('workflows', [{ id: 'echo' }]).map((t) => t.label)).toEqual(['Workflows', 'Templates']);
    expect(visibleTabs('workflows', [{ id: 'landfall' }]).map((t) => t.label)).toEqual(['Workflows', 'Templates', 'Runbooks']);
  });
});

describe('the offline dot', () => {
  it('is off when every plugin is online and on, with a title, when one is not', () => {
    expect(offlineDot([])).toEqual({ dot: false });
    expect(offlineDot([{ status: 'online' }, { status: 'online' }])).toEqual({ dot: false });
    expect(offlineDot([{ status: 'online' }, { status: 'offline' }])).toEqual({ dot: true, title: '1 plugin offline' });
    expect(offlineDot([{ status: 'error' }, { status: 'offline' }])).toEqual({ dot: true, title: '2 plugins offline' });
  });
});

describe('the reconnecting line', () => {
  it('stays hidden until the stream was connected once, and shows when it then drops', () => {
    expect(showReconnecting(false, false)).toBe(false);
    expect(showReconnecting(true, true)).toBe(false);
    expect(showReconnecting(true, false)).toBe(true);
  });
});

describe('the user menu', () => {
  it('holds Theme and Build a plugin when open', async () => {
    const { ThemeChoice } = await import('../src/components/shell/theme-toggle');
    const theme = renderToStaticMarkup(createElement(ThemeChoice));
    expect(theme).toContain('Theme');
    for (const label of ['System', 'Light', 'Dark']) expect(theme).toContain(label);
    const { UserMenu } = await import('../src/components/auth/user-menu');
    const menu = renderToStaticMarkup(createElement(UserMenu, { defaultOpen: true }));
    expect(menu).toContain('Theme');
    expect(menu).toContain('href="/developers"');
    expect(menu).toContain('Build a plugin');
  });
});
