/**
 * The Brain workbench's files (lib/shared/brain-files.ts): the tree (folders per type, people per department, names
 * that don't collide, decorations), each file's Markdown and its outline, and the anchors the Preview and the Outline
 * share.
 */
import { describe, expect, it } from 'vitest';
import { brainTree, byDay, fileNameOf, indexMarkdown, logMarkdown, outlineOf, pageMarkdown, refOfPath, sectionId, urlOf, type TreeFolder } from '@/lib/shared/brain-files';
import type { BrainStatus } from '@/lib/shared/brain';
import type { WikiEntry, WikiHome, WikiPage, WorkItem } from '@/lib/shared/brain-wiki';

const entry = (type: WikiEntry['type'], id: string, name: string, extra: Partial<WikiEntry> = {}): WikiEntry => ({ type, id, name, week: 0, month: 0, teams: [], ...extra });
const work = (id: string, at: string, extra: Partial<WorkItem> = {}): WorkItem => ({ id, at, kind: 'work.discussion', source: 'slack', refs: [], ...extra });

const home = {
  status: { facts: 3 } as BrainStatus,
  days: 7,
  entries: [
    entry('customer', 'acme', 'Acme', { week: 2 }),
    entry('customer', 'acme-2', 'Acme'),
    entry('initiative', 'atlas', 'Atlas'),
    entry('person', 'dana-example.com', 'Dana Levi', { department: 'R&D' }),
    entry('person', 'kim-example.com', 'Kim'),
  ],
  shared: [{ ref: 'customer/acme', type: 'customer', id: 'acme', name: 'Acme', teams: [{ team: 'Sales', events: 1, people: ['Lee'] }, { team: 'R&D', events: 1, people: ['Dana Levi'] }], events: 2, lastAt: '2026-11-12T10:00:00Z', latest: [] }],
  teams: [],
  kinds: [],
  recent: [work('w2', '2026-11-12T10:00:00Z', { title: 'ENG-42', refs: ['customer/acme', 'person/dana-example.com'], team: 'R&D' }), work('w1', '2026-11-11T09:00:00Z', { title: 'Kickoff', actor: 'kim@example.com' })],
  proposals: [],
  health: { noOwner: [{ ref: 'initiative/atlas', name: 'Atlas' }], quiet: [{ ref: 'initiative/atlas', name: 'Atlas' }], staleSummaries: [] },
  model: 'fake/wiki',
} as WikiHome;

describe('brainTree', () => {
  const tree = brainTree(home);

  it('has a folder per type with entries, people by department, then index.md and log.md', () => {
    expect(tree.nodes.map((n) => n.name)).toEqual(['initiatives', 'customers', 'people', 'index.md', 'log.md']);
    const people = tree.nodes[2] as TreeFolder;
    expect(people.children.map((n) => n.name)).toEqual(['R&D', 'no department']);
    expect(tree.paths.get('person/dana-example.com')).toEqual(['people', 'R&D', 'dana-levi.md']);
  });

  it('names files from the page name, keeping two of the same name apart', () => {
    expect(fileNameOf({ name: 'Kestrel Bank', id: 'x' })).toBe('kestrel-bank.md');
    expect(tree.files.get('customer/acme')?.name).toBe('acme.md');
    expect(tree.files.get('customer/acme-2')?.name).toBe('acme-acme-2.md');
  });

  it('decorates files: work this week, shared across teams, and what needs a person', () => {
    expect(tree.files.get('customer/acme')).toMatchObject({ week: 2, shared: true, problems: [] });
    expect(tree.files.get('initiative/atlas')?.problems).toEqual(['no owner', 'quiet for 30 days']);
  });
});

describe('Markdown', () => {
  const page = {
    entity: { type: 'customer', id: 'acme', name: 'Acme', description: 'Our first customer', owner: 'Lee', attrs: { tier: 'enterprise' }, source: 'workflow', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z' },
    facts: [{ id: 'f1', kind: 'purpose', statement: 'Renews in March' }],
    proposals: [],
    summary: { text: 'Acme works with [[person/dana-example.com|Dana Levi]] [1].', model: 'fake/wiki', generatedAt: '2026-11-12T00:00:00Z', stale: true, links: [{ ref: 'person/dana-example.com', name: 'Dana Levi' }] },
    work: [work('w2', '2026-11-12T10:00:00Z', { title: 'ENG-42', url: 'https://linear.example/ENG-42', summary: 'Export times out', refs: ['customer/acme', 'person/dana-example.com'], team: 'R&D' })],
    people: [{ ref: 'person/dana-example.com', name: 'Dana Levi', team: 'R&D', events: 1 }],
    related: [{ ref: 'initiative/atlas', type: 'initiative', id: 'atlas', name: 'Atlas', shared: 1 }],
    teams: [{ team: 'R&D', events: 1 }],
    mentionedIn: [{ ref: 'initiative/atlas', name: 'Atlas' }],
    canEdit: true,
  } as unknown as WikiPage;

  it('writes a page as frontmatter, the summary, then its sections with links', () => {
    const md = pageMarkdown(page);
    expect(md.startsWith('---\ntype: customer\nid: acme\nname: Acme\nowner: Lee\nteams: [R&D]\nsources: [slack]\ntier: enterprise\n')).toBe(true);
    expect(md).toContain('summary: "fake/wiki, 2026-11-12T00:00:00Z, behind its work"');
    expect(md).toContain('# Acme\n\n> Our first customer\n\n## Summary\n\nAcme works with [[person/dana-example.com|Dana Levi]] [1].');
    expect(md).toContain('1. 2026-11-12 · slack · discussion — [ENG-42](https://linear.example/ENG-42) — [[customer/acme|Acme]] [[person/dana-example.com|Dana Levi]] — team R&D\n   > Export times out');
    expect(md).toContain('## People\n\n- [[person/dana-example.com|Dana Levi]] — R&D, 1 item');
    expect(md).toContain('## Related pages\n\n- [[initiative/atlas|Atlas]] — 1 shared item');
    expect(md).toContain('## Facts\n\n- (purpose) Renews in March');
  });

  it('outlines a file by its ## headings, with the anchors the Preview uses', () => {
    expect(outlineOf(pageMarkdown(page)).map((o) => o.title)).toEqual(['Summary', 'Work', 'People', 'Related pages', 'Facts', 'Mentioned in']);
    expect(outlineOf('# A\n\n## Mentioned in\n')[0]).toEqual({ title: 'Mentioned in', id: 'sec-mentioned-in', line: 3 });
    expect(sectionId('Teams this week')).toBe('sec-teams-this-week');
  });

  it('writes index.md as the briefing and log.md a heading per day', () => {
    const index = indexMarkdown(home);
    expect(index).toContain('## Shared across teams\n\n- [[customer/acme|Acme]] — 2 teams, 2 items\n  - Sales: 1 (Lee)');
    expect(index).toContain('## Needs a person\n\n- No owner: [[initiative/atlas|Atlas]]\n- Quiet for 30 days: [[initiative/atlas|Atlas]]');
    const log = logMarkdown(home);
    expect(outlineOf(log).map((o) => o.title)).toEqual(['2026-11-12', '2026-11-11']);
    // Someone without a page is named by their email.
    expect(log).toContain('slack · discussion — Kickoff — kim@example.com');
    expect(byDay(home.recent).map(([d, items]) => [d, items.length])).toEqual([
      ['2026-11-12', 1],
      ['2026-11-11', 1],
    ]);
  });
});

describe('addresses', () => {
  it('maps paths to files and back', () => {
    expect(refOfPath(undefined)).toBe('index');
    expect(refOfPath(['log'])).toBe('log');
    expect(refOfPath(['settings'])).toBe('settings');
    expect(refOfPath(['nonsense'])).toBe('index');
    expect(refOfPath(['person', 'dana-example.com'])).toBe('person/dana-example.com');
    expect(urlOf('index')).toBe('/brain');
    expect(urlOf('customer/acme')).toBe('/brain/customer/acme');
  });
});
