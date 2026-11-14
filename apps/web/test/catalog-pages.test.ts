/**
 * The catalog pages' logic and markup: Plugins' node chips, Explore's item types (no workflows), the source filter with
 * one marketplace, the Installed type filter, and the Templates order and dimmed card.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { chipsToShow, NODE_CHIPS, PluginCard } from '../src/components/plugins/plugin-card';
import { buildItems, KINDS, showSourceFilter } from '../src/components/marketplace/explore';
import { installedShows } from '../src/components/marketplace/installed-list';
import { missingPlugins, needsLabel, sortTemplates, TemplateCard } from '../src/components/templates/template-card';
import type { ExplorePlugin } from '../src/lib/shared/marketplace';
import type { TemplateSummary } from '../src/lib/shared/templates';
import type { PluginSummary } from '../src/lib/shared/types';

const nodes = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `node${i}`, displayName: `Node ${i}`, description: '', icon: 'blocks' }));
const plugin = (n: number) =>
  ({
    id: 'big',
    status: 'online',
    source: 'registered',
    transport: 'http',
    endpoints: [],
    nodes: nodes(n),
    info: { name: 'Big Plugin', version: '1.0.0', description: 'Many nodes', language: 'typescript', icon: 'blocks', color: '#6366f1' },
  }) as unknown as PluginSummary;

describe('chipsToShow', () => {
  it('shows 12 and counts the rest', () => {
    expect(chipsToShow(nodes(76))).toMatchObject({ more: 64 });
    expect(chipsToShow(nodes(76)).shown).toHaveLength(NODE_CHIPS);
    expect(chipsToShow(nodes(5))).toMatchObject({ more: 0 });
    expect(chipsToShow(nodes(12)).more).toBe(0);
  });
});

describe('plugin card', () => {
  it('a folded card with 76 nodes has 12 chips and +64', () => {
    const html = renderToStaticMarkup(createElement(PluginCard, { plugin: plugin(76), onChange: () => {}, expanded: false, onToggle: () => {} }));
    expect(html.match(/title="Node \d+"/g)).toHaveLength(12);
    expect(html).toContain('+64');
    expect(html).toContain('76 nodes');
  });
});

describe('Explore', () => {
  const claude = { marketplace: { id: 'm1', name: 'One' }, name: 'helper', keywords: [], category: 'tools', installed: false, flows: 3 } as unknown as ExplorePlugin;
  const node = { marketplace: { id: 'm1', name: 'One' }, name: 'nodes', keywords: [], flows: 2, landflow: true } as unknown as ExplorePlugin;
  it('lists plugins, agents and skills, and composites, never workflows', () => {
    expect(KINDS.map((k) => k.id)).toEqual(['all', 'nodes', 'composites', 'claude']);
    const items = buildItems([claude, node], [], []);
    expect(items.map((i) => i.kind).sort()).toEqual(['claude', 'nodes']);
    expect(items.every((i) => (i.kind as string) !== 'flows')).toBe(true);
  });
  it('hides the source menu with one marketplace', () => {
    expect(showSourceFilter(1)).toBe(false);
    expect(showSourceFilter(0)).toBe(false);
    expect(showSourceFilter(2)).toBe(true);
  });
});

describe('Installed', () => {
  it('the type filter picks plugins, skills or both', () => {
    expect(installedShows('all')).toEqual({ plugins: true, skills: true });
    expect(installedShows('plugins')).toEqual({ plugins: true, skills: false });
    expect(installedShows('skills')).toEqual({ plugins: false, skills: true });
  });
});

describe('Templates', () => {
  const template = (id: string, usable: boolean, nodeType = 'github.issue'): TemplateSummary =>
    ({
      id,
      name: id,
      description: '',
      source: 'builtin',
      categories: [],
      credentials: [],
      nodeTypes: [],
      nodeCount: 2,
      usable,
      problems: usable ? [] : [{ kind: 'missing', nodeType, message: `Needs the ${nodeType} plugin` }],
    }) as unknown as TemplateSummary;

  it('sorts ready templates first and keeps each group stable', () => {
    const sorted = sortTemplates([template('a', false), template('b', true), template('c', false), template('d', true)]);
    expect(sorted.map((t) => t.id)).toEqual(['b', 'd', 'a', 'c']);
  });
  it('names the missing plugins', () => {
    expect(missingPlugins([{ kind: 'missing', nodeType: 'github.issue', message: '' }, { kind: 'missing', nodeType: 'github.pr', message: '' }])).toEqual(['github']);
    expect(needsLabel(template('x', false, 'slack.post').problems)).toBe('Needs slack');
    const many = ['a', 'b', 'c'].map((p) => ({ kind: 'missing' as const, nodeType: `${p}.x`, message: '' }));
    expect(needsLabel(many)).toBe('Needs a +2');
  });
  it('a card that cannot be used is dimmed and says what it needs', () => {
    const render = (t: TemplateSummary) => renderToStaticMarkup(createElement(TemplateCard, { template: t, types: {}, index: 0, href: '/templates/x' }));
    const dimmed = render(template('x', false, 'slack.post'));
    expect(dimmed).toContain('opacity-60');
    expect(dimmed).toContain('Needs slack');
    const ready = render(template('y', true));
    expect(ready).not.toContain('opacity-60');
    expect(ready).not.toContain('Needs');
  });
});
