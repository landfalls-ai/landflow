/**
 * Settings in five groups: every section sits in exactly one group, the old API docs link goes to Developers, the
 * status rows say what is set, the audit filters apply on change, and the help-tip is a keyboard-reachable button.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { API_REFERENCE_HREF, SETTINGS_GROUPS, resolveSection, sectionFromLocation } from '../src/components/settings/settings-groups';
import { groupIssues, statusRow } from '../src/components/settings/status-rows';
import { NO_FILTERS, auditQuery, filtersReducer, hasPending, initialFilters } from '../src/components/settings/audit-filters';
import { HelpTip, HelpTipBody, HelpTipButton } from '../src/components/ui/help-tip';

const pageSource = readFileSync(join(import.meta.dirname, '..', 'src', 'app', 'settings', 'page.tsx'), 'utf8');
const pageSectionIds = [...pageSource.matchAll(/^ {2}\{ id: '([a-z-]+)', label:/gm)].map((m) => m[1]!);

describe('settings groups', () => {
  it('has the five groups in order', () => {
    expect(SETTINGS_GROUPS.map((g) => g.label)).toEqual(['Workspace', 'People & access', 'Governance', 'AI', 'Infrastructure']);
  });

  it('covers every section of the page exactly once', () => {
    const grouped = SETTINGS_GROUPS.flatMap((g) => g.sections);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual([...pageSectionIds].sort());
    expect(pageSectionIds).toContain('ai-caps');
    expect(pageSectionIds).not.toContain('api');
  });

  it('sends the old API docs link to Developers, from the hash and from ?section=', () => {
    const known = pageSectionIds;
    expect(resolveSection('#api', known)).toEqual({ kind: 'redirect', href: API_REFERENCE_HREF });
    expect(resolveSection(sectionFromLocation('?section=api', ''), known)).toEqual({ kind: 'redirect', href: '/developers#api-reference' });
    expect(resolveSection(sectionFromLocation('', '#security'), known)).toEqual({ kind: 'section', id: 'security' });
    expect(resolveSection('#ai-prices', known)).toEqual({ kind: 'section', id: 'ai-prices' });
    expect(resolveSection('#nope', known)).toEqual({ kind: 'none' });
    expect(resolveSection('', known)).toEqual({ kind: 'none' });
  });

  it('keeps every old section id reachable', () => {
    const old = ['general', 'variables', 'alerts', 'ai-prices', 'mcp', 'users', 'api-keys', 'security', 'audit', 'governance', 'source-control', 'environments', 'external-secrets', 'workers', 'transports'];
    for (const id of old) expect(resolveSection(`#${id}`, pageSectionIds)).toEqual({ kind: 'section', id });
  });
});

describe('status rows', () => {
  it('says SSO is not configured, with the how-to link', () => {
    expect(statusRow({ label: 'SSO', configured: false })).toEqual({ text: 'SSO: not configured', state: 'off', help: 'How to set up' });
  });
  it('says SSO is configured', () => {
    expect(statusRow({ label: 'SSO', configured: true })).toEqual({ text: 'SSO: configured', state: 'on', help: 'Details' });
  });
  it('takes its own words for a state', () => {
    expect(statusRow({ label: 'Queue mode', configured: false, off: 'off' }).text).toBe('Queue mode: off');
  });
  it('groups identical errors into one issue', () => {
    const issues = groupIssues([
      { label: 'NATS', message: 'connect ECONNREFUSED' },
      { label: 'Kafka', message: 'connect ECONNREFUSED' },
      { label: 'HTTP' },
      { label: 'Redis', message: 'auth failed' },
    ]);
    expect(issues).toEqual([
      { message: 'connect ECONNREFUSED', labels: ['NATS', 'Kafka'] },
      { message: 'auth failed', labels: ['Redis'] },
    ]);
  });
});

describe('audit filters', () => {
  it('applies a choice at once', () => {
    const next = filtersReducer(initialFilters(), { type: 'choose', patch: { outcome: 'denied' } });
    expect(next.applied.outcome).toBe('denied');
    expect(next.draft).toBe(next.applied);
  });
  it('shows typing at once and applies it on commit', () => {
    const typed = filtersReducer(initialFilters(), { type: 'type', patch: { q: 'publish' } });
    expect(typed.draft.q).toBe('publish');
    expect(typed.applied.q).toBe('');
    expect(hasPending(typed)).toBe(true);
    const done = filtersReducer(typed, { type: 'commit' });
    expect(done.applied.q).toBe('publish');
    expect(hasPending(done)).toBe(false);
    expect(filtersReducer(done, { type: 'commit' })).toBe(done);
  });
  it('a choice also applies the text typed before it', () => {
    const typed = filtersReducer(initialFilters(), { type: 'type', patch: { actor: 'ada' } });
    expect(filtersReducer(typed, { type: 'choose', patch: { outcome: 'failure' } }).applied).toMatchObject({ actor: 'ada', outcome: 'failure' });
  });
  it('resets to the fixed filters (a project page keeps its project)', () => {
    const fixed = { ...NO_FILTERS, projectId: 'p1' };
    const typed = filtersReducer(initialFilters(fixed), { type: 'choose', patch: { q: 'x' } });
    expect(filtersReducer(typed, { type: 'reset', to: fixed })).toEqual({ draft: fixed, applied: fixed });
  });
  it('builds the query, a bare end date running to the end of the day', () => {
    expect(auditQuery({ ...NO_FILTERS, q: 'a b', to: '2026-01-31' }, { limit: '50' })).toBe('to=2026-01-31T23%3A59%3A59.999Z&q=a+b&limit=50');
  });
  it('has no Apply button any more', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'components', 'settings', 'audit-settings.tsx'), 'utf8');
    expect(source).not.toMatch(/>\s*Apply\s*</);
  });
});

describe('help tip', () => {
  it('is a button that says whether it is open', () => {
    const html = renderToStaticMarkup(createElement(HelpTip, { label: 'How to set up SSO' }, 'Set the variables.'));
    expect(html).toMatch(/<button[^>]*type="button"/);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-label="How to set up SSO"');
  });
  it('shows its link words when it has some', () => {
    expect(renderToStaticMarkup(createElement(HelpTip, { label: 'x', text: 'How to set up ›' }, 'y'))).toContain('How to set up ›');
  });
  it('renders open, and its popover holds the explanation', () => {
    expect(renderToStaticMarkup(createElement(HelpTipButton, { label: 'More', open: true }))).toContain('aria-expanded="true"');
    expect(renderToStaticMarkup(createElement(HelpTipBody, null, 'LANDFLOW_OIDC_ISSUER sets the issuer.'))).toContain('LANDFLOW_OIDC_ISSUER sets the issuer.');
  });
});
