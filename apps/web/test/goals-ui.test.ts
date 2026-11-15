/**
 * The goals screens: the tree helpers, the section tabs, and the goal card and brief card as static markup, with made-up data.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { GoalNode, ProjectBriefView } from '../src/lib/shared/goals';
import { allowedParents, briefFold, filterTree, flattenTree, formatTarget, pickerOptions } from '../src/components/goals/tree';
import { groupOf, stripGroup } from '../src/components/shell/section-nav';
import { GoalCard } from '../src/components/goals/goal-card';
import { ProjectBriefCard } from '../src/components/projects/project-brief-card';

vi.mock('../src/components/auth/viewer', () => ({ useViewer: () => ({ id: 'u1', name: 'Test Owner', email: 'owner@landflow.test', role: 'owner', sso: false }) }));
vi.mock('next/link', () => ({ default: (p: { href: string; children: unknown; className?: string }) => createElement('a', { href: p.href, className: p.className }, p.children as never) }));

const node = (id: string, title: string, over: Partial<GoalNode> = {}, children: GoalNode[] = []): GoalNode => ({
  id,
  title,
  level: 'company',
  status: 'active',
  createdAt: '2027-01-01T00:00:00Z',
  updatedAt: '2027-01-01T00:00:00Z',
  projects: [],
  initiatives: [],
  canEdit: true,
  children,
  ...over,
});

const leaf = node('g3', 'Invoices export to the ERP without manual steps', { level: 'project', projectId: 'p1', parentId: 'g2', projects: [{ id: 'p1', name: 'Billing revamp' }] });
const mid = node('g2', 'Halve month-end close time', { level: 'project', projectId: 'p1', parentId: 'g1', projects: [{ id: 'p1', name: 'Billing revamp' }] }, [leaf]);
const root = node('g1', 'Every finance team closes the month in one day', {}, [mid]);
const cancelled = node('g4', 'Old idea', { status: 'cancelled' });
const tree = [root, cancelled];

describe('flattenTree', () => {
  it('shows children only under an expanded node', () => {
    expect(flattenTree(tree, new Set()).map((r) => r.node.id)).toEqual(['g1', 'g4']);
    const rows = flattenTree(tree, new Set(['g1', 'g2']));
    expect(rows.map((r) => [r.node.id, r.depth])).toEqual([['g1', 1], ['g2', 2], ['g3', 3], ['g4', 1]]);
    expect(rows[0]).toMatchObject({ hasChildren: true, expanded: true });
    expect(rows[2]).toMatchObject({ hasChildren: false, parentId: 'g2' });
  });
  it('does not open a branch that was never expanded below an open one', () => {
    expect(flattenTree(tree, new Set(['g1'])).map((r) => r.node.id)).toEqual(['g1', 'g2', 'g4']);
  });
});

describe('filterTree', () => {
  it('Active hides finished goals, keeping a parent for a match', () => {
    expect(filterTree(tree, { activeOnly: true }).map((n) => n.id)).toEqual(['g1']);
    expect(filterTree(tree, { activeOnly: false }).map((n) => n.id)).toEqual(['g1', 'g4']);
  });
  it('a project filter keeps the path to its goals', () => {
    const out = filterTree(tree, { activeOnly: false, projectId: 'p1' });
    expect(out.map((n) => n.id)).toEqual(['g1']);
    expect(out[0]!.children[0]!.children[0]!.id).toBe('g3');
  });
});

describe('allowedParents', () => {
  it('a company goal sits only under a company goal', () => {
    expect(allowedParents(tree, 'company').map((n) => n.id)).toEqual(['g1', 'g4']);
  });
  it('a project goal may sit under either level', () => {
    expect(allowedParents(tree, 'project').map((n) => n.id)).toEqual(['g1', 'g2', 'g3', 'g4']);
  });
  it('never itself or what is under it', () => {
    expect(allowedParents(tree, 'project', 'g2').map((n) => n.id)).toEqual(['g1', 'g4']);
  });
  it('keeps the tree at four deep, a goal’s own subtree counted', () => {
    const d4 = node('d4', 'Depth four', {}, []);
    const d3 = node('d3', 'Depth three', {}, [d4]);
    const d2 = node('d2', 'Depth two', {}, [d3]);
    const d1 = node('d1', 'Depth one', {}, [d2]);
    expect(allowedParents([d1], 'company').map((n) => n.id)).toEqual(['d1', 'd2', 'd3']);
    // g (a leaf) may go under d3 but not under d4; a goal with two levels under it may not go under d3.
    const two = node('two', 'Two levels', {}, [node('two-a', 'Child')]);
    expect(allowedParents([d1, two], 'company', 'two').map((n) => n.id)).toEqual(['d1', 'd2']);
  });
});

describe('pickerOptions', () => {
  it('indents by depth and leaves cancelled goals out', () => {
    const options = pickerOptions(tree);
    expect(options.map((o) => o.label)).toEqual(['Every finance team closes the month in one day', '  └ Halve month-end close time', '    └ Invoices export to the ERP without manual steps']);
  });
  it('puts the project’s goals first', () => {
    const other = node('g9', 'Cut cloud spend', { level: 'company' });
    const options = pickerOptions([other, root], 'p1');
    expect(options.map((o) => [o.id, o.group])).toEqual([['g2', 'project'], ['g3', 'project'], ['g9', 'other'], ['g1', 'other']]);
  });
  it('leaves out excluded ids', () => {
    expect(pickerOptions(tree, undefined, new Set(['g2'])).map((o) => o.id)).toEqual(['g1', 'g3']);
  });
});

describe('briefFold', () => {
  it('keeps the first lines and says when it cut', () => {
    expect(briefFold('a\nb\nc\nd', 3)).toEqual({ text: 'a\nb\nc', folded: true });
    expect(briefFold('a\nb', 3)).toEqual({ text: 'a\nb', folded: false });
    expect(briefFold('', 3)).toEqual({ text: '', folded: false });
  });
});

describe('formatTarget', () => {
  it('reads a plain date without a time zone', () => {
    expect(formatTarget('2027-03-05')).toBe('5 Mar 2027');
    expect(formatTarget('nope')).toBeUndefined();
  });
});

describe('the Projects | Goals tabs', () => {
  it('/goals and /projects belong to the projects group; a project page shows no strip', () => {
    expect(groupOf('/goals')).toBe('projects');
    expect(groupOf('/projects')).toBe('projects');
    expect(groupOf('/projects/p1')).toBe('projects');
    expect(stripGroup('/goals')).toBe('projects');
    expect(stripGroup('/projects')).toBe('projects');
    expect(stripGroup('/projects/p1')).toBeUndefined();
  });
});

describe('GoalCard', () => {
  it('shows title, status, level, parent and the sub-goal count', () => {
    const html = renderToStaticMarkup(createElement(GoalCard, { goal: mid, parent: root.title, onOpen: () => {}, onDrill: () => {} }));
    expect(html).toContain('Halve month-end close time');
    expect(html).toContain('Active');
    expect(html).toContain('Project');
    expect(html).toContain('Under: Every finance team closes the month in one day');
    expect(html).toContain('1 sub-goal');
  });
  it('has no drill row for a leaf', () => {
    const html = renderToStaticMarkup(createElement(GoalCard, { goal: leaf, onOpen: () => {} }));
    expect(html).not.toContain('sub-goal');
    expect(html).not.toContain('Under:');
  });
});

describe('ProjectBriefCard', () => {
  const full: ProjectBriefView = {
    brief: 'Replace the manual invoice run.',
    constraints: 'No changes to the ledger schema.',
    doneWhen: 'Close takes one working day.',
    glossary: 'Close: the monthly lock.',
    status: 'active',
    targetDate: '2027-06-30',
    leadName: 'Ada Example',
    decisionOwnerName: 'Grace Example',
    goals: [{ id: 'g2', title: 'Halve month-end close time', level: 'project', status: 'active' }, { id: 'g3', title: 'Invoices export to the ERP without manual steps', level: 'project', status: 'planned' }],
    canEdit: true,
  };
  const render = (brief?: ProjectBriefView) => renderToStaticMarkup(createElement(ProjectBriefCard, { projectId: 'p1', brief, onChanged: () => {} }));
  it('shows the header, the fields, and the goals in order with the admin buttons', () => {
    const html = render(full);
    for (const text of ['Active', 'Target 30 Jun 2027', 'Lead:', 'Ada Example', 'Decision owner:', 'Grace Example', 'Brief', 'Constraints', 'Done when', 'Words we use', 'Replace the manual invoice run.', 'Link a goal', 'New project goal', 'Edit brief']) expect(html).toContain(text);
    expect(html.indexOf('Halve month-end close time')).toBeLessThan(html.indexOf('Invoices export'));
    expect(html).toContain('Move Halve month-end close time down');
  });
  it('hides the edit buttons from a viewer who cannot edit', () => {
    const html = render({ ...full, canEdit: false });
    expect(html).not.toContain('Edit brief');
    expect(html).not.toContain('Link a goal');
  });
  it('an empty brief asks an admin to write one, and shows a viewer nothing', () => {
    expect(render({ goals: [], canEdit: true })).toContain('Give this project a brief and goals: agents that work here will read them');
    expect(render({ goals: [], canEdit: false })).toBe('');
    expect(render(undefined)).toBe('');
  });
});
