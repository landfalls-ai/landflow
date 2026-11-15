/**
 * The "Your morning" card (components/brain/briefing-card.tsx): markup for a nightly, a live and an empty briefing, the
 * links it may show, the delivery choice, the setup line and the collapsed lists. Made-up data only.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BriefingView, changeDelivery, collapse, COLLAPSE_AT, EMPTY_TEXT, LIVE_TEXT, safeHref, SETUP_LABEL, showSetup, type BriefingViewProps } from '../src/components/brain/briefing-card';
import type { Briefing, WorkItem } from '../src/lib/shared/brain-work';

const item = (n: number, extra: Partial<WorkItem> = {}): WorkItem => ({ id: `w${n}`, sourceId: `s${n}`, source: 'claude-code', kind: 'work.session', title: `Item ${n}`, at: new Date().toISOString(), visibility: 'private', ...extra });
const base: Briefing = { day: '2026-11-15', generatedAt: new Date().toISOString(), source: 'live', today: [], yesterday: [], related: [], autoSend: 'allowed', brain: 'on' };
const render = (briefing: Partial<Briefing>, props: Partial<BriefingViewProps> = {}) => renderToStaticMarkup(createElement(BriefingView, { briefing: { ...base, ...briefing }, delivery: 'none', ...props }));

describe('briefing card markup', () => {
  it('a nightly briefing leads with its text, then yesterday and related with the reason chip', () => {
    const html = render({
      source: 'flow',
      summary: 'Yesterday you merged 2 PRs in acme/billing.',
      yesterday: [item(1, { repo: 'acme/billing' })],
      related: [{ person: { name: 'Sam Example', userId: 'u2' }, items: [item(2, { title: 'Billing retries' })], because: { type: 'repo', name: 'acme/billing' } }],
    });
    expect(html).toContain('Your morning');
    expect(html).toContain('Yesterday you merged 2 PRs in acme/billing.');
    expect(html).not.toContain(LIVE_TEXT);
    expect(html).toContain('Yesterday');
    expect(html).toContain('Related');
    expect(html).toContain('Sam Example');
    expect(html).toContain('repo: acme/billing');
    expect(html).toContain('Billing retries');
  });

  it('a live briefing says there is no nightly sync yet', () => {
    const html = render({ yesterday: [item(1)] });
    expect(html).toContain(LIVE_TEXT);
    expect(html).toContain('Item 1');
  });

  it('an empty briefing says so, and nothing renders with the brain off', () => {
    expect(render({})).toContain(EMPTY_TEXT);
    expect(render({ brain: 'off' })).toBe('');
  });

  it('shows only allowed link hosts as links', () => {
    const html = render({
      yesterday: [item(1, { title: 'Mine', url: 'https://github.com/acme/billing/pull/7' }), item(2, { title: 'Evil', url: 'https://evil.example/x' }), item(3, { title: 'Local', url: 'http://localhost:3203/brain' })],
    }, { origin: 'http://localhost:3203' });
    expect(html).toContain('href="https://github.com/acme/billing/pull/7"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('href="/brain"');
    expect(html).not.toContain('evil.example');
    expect(html).toContain('Evil');
  });

  it('safeHref refuses other schemes, other hosts and look-alikes', () => {
    expect(safeHref('/runs/1')).toEqual({ href: '/runs/1', external: false });
    expect(safeHref('//evil.example/x')).toBeUndefined();
    expect(safeHref('javascript:alert(1)')).toBeUndefined();
    expect(safeHref('http://github.com/a/b')).toBeUndefined();
    expect(safeHref('https://github.com.evil.example/a')).toBeUndefined();
    expect(safeHref('https://user:pw@github.com/a')).toBeUndefined();
    expect(safeHref('https://github.com/a/b')?.external).toBe(true);
    expect(safeHref('http://localhost:3203/x?y=1', 'http://localhost:3203')).toEqual({ href: '/x?y=1', external: false });
    expect(safeHref(undefined)).toBeUndefined();
  });
});

describe('delivery', () => {
  it('reads "here only" by default and names the channel otherwise', () => {
    expect(render({}, { delivery: 'none' })).toContain('Delivered here only');
    expect(render({}, { delivery: 'slack' })).toContain('Delivered here and by Slack');
    expect(render({}, { delivery: 'none' })).toContain('Change');
  });

  it('the menu writes briefingDelivery, and Slack says what it needs', async () => {
    const save = vi.fn(async () => {});
    expect(await changeDelivery('email', save)).toMatch(/mail settings/);
    expect(await changeDelivery('slack', save)).toMatch(/Slack needs an admin/);
    expect(await changeDelivery('none', save)).toBeUndefined();
    expect(save.mock.calls).toEqual([['briefingDelivery', 'email'], ['briefingDelivery', 'slack'], ['briefingDelivery', 'none']]);
  });
});

describe('set up tomorrow sync', () => {
  const sync = { nodeTypes: ['core.schedule', 'core.brainListPeople', 'core.brainGatherWork'] };
  it('only for admins, and only without the workflow', () => {
    expect(showSetup(true, [])).toBe(true);
    expect(showSetup(true, [{ nodeTypes: ['http'] }])).toBe(true);
    expect(showSetup(true, [sync])).toBe(false);
    expect(showSetup(true, [{ nodeTypes: ['brainListPeople'] }])).toBe(false);
    expect(showSetup(false, [])).toBe(false);
    expect(showSetup(true, undefined)).toBe(false);
  });

  it('the line shows only when asked for', () => {
    expect(render({}, { canSetup: true })).toContain(SETUP_LABEL);
    expect(render({}, { canSetup: false })).not.toContain(SETUP_LABEL);
  });
});

describe('collapsing', () => {
  const many = Array.from({ length: 5 }, (_, i) => i);
  it('keeps the first three and counts the rest', () => {
    expect(collapse(many, false)).toEqual({ shown: [0, 1, 2], hidden: 2 });
    expect(collapse(many, true)).toEqual({ shown: many, hidden: 0 });
    expect(collapse(many.slice(0, COLLAPSE_AT), false).hidden).toBe(0);
  });

  it('the card lists three items and offers the rest', () => {
    const html = render({ yesterday: [1, 2, 3, 4, 5].map((n) => item(n)) });
    expect(html).toContain('Item 3');
    expect(html).not.toContain('Item 4');
    expect(html).toContain('Show 2 more');
  });
});
