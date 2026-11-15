/**
 * The Practices screens on the Brain page (docs/practices.md): grouping and the amber rule, refs, the card's markup, the
 * review dialog's rules and the form's validation. Pure functions and static markup: the tests run in node.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { isPageRef, isPracticeRef, practiceRef, refOfPath } from '@/lib/shared/brain-files';
import type { PracticeApplication, PracticeCitation, PracticeDetailResponse, PracticeVersion, PracticeView } from '@/lib/shared/practices';
import { PracticeCard } from '@/components/brain/wiki/practice-doc';
import {
  approveBlockers,
  approveBody,
  checkSentence,
  draftInput,
  editBase,
  emptyCheck,
  emptyForm,
  groupPractices,
  mergeConflicts,
  reasonValid,
  reviewError,
  validatePracticeForm,
  versionDiff,
  waitingVersion,
} from '@/components/brain/wiki/practices-logic';

const NOW = '2026-11-15T10:00:00.000Z';
const version = (over: Partial<PracticeVersion> = {}): PracticeVersion => ({
  practiceId: 'prc_a',
  version: 1,
  title: 'Charts live in deploy/helm',
  strength: 'required',
  topics: ['helm'],
  repos: ['acme/web'],
  paths: ['deploy/**'],
  summary: 'Charts live in deploy/helm/<service>/.',
  body: 'One chart per service.',
  checks: [],
  citations: [],
  source: 'person',
  tainted: false,
  draftedBy: 'user:u1',
  createdAt: NOW,
  sha256: 'x',
  ...over,
});
const practice = (over: Partial<PracticeView> = {}): PracticeView => ({
  id: 'prc_a',
  handle: 'helm/chart-location',
  title: 'Charts live in deploy/helm',
  level: 'org',
  strength: 'required',
  topics: ['helm'],
  repos: ['acme/web'],
  paths: ['deploy/**'],
  status: 'approved',
  approvedVersion: 1,
  createdAt: NOW,
  updatedAt: NOW,
  approved: version(),
  drafts: [],
  canApprove: true,
  canDraft: true,
  ...over,
});
const names = (id: string) => (id === 'p2' ? 'Zeta' : 'Alpha');

describe('refs', () => {
  it('names a practice file and keeps it out of the wiki routes', () => {
    expect(practiceRef('prc_x')).toBe('practices/prc_x');
    expect(isPracticeRef('practices/prc_x')).toBe(true);
    expect(isPracticeRef('person/dana')).toBe(false);
    expect(refOfPath(['practices', 'prc_x'])).toBe('practices/prc_x');
    expect(isPageRef('practices/prc_x')).toBe(false);
    expect(isPageRef('person/dana')).toBe(true);
    expect(isPageRef('index')).toBe(false);
  });
});

describe('the Practices view', () => {
  it('lists the organization first, then projects by name, with a folder per first topic', () => {
    const list = [
      practice({ id: '1', handle: 'z/last', level: 'project', projectId: 'p2', topics: ['config'] }),
      practice({ id: '2', handle: 'a/first', level: 'project', projectId: 'p1', topics: ['config'] }),
      practice({ id: '3', handle: 'o/two', topics: ['monitoring', 'devops'] }),
      practice({ id: '4', handle: 'o/one', topics: ['helm'] }),
      practice({ id: '5', handle: 'o/none', topics: [] }),
    ];
    const { groups } = groupPractices(list, names);
    expect(groups.map((g) => g.label)).toEqual(['Organization', 'Alpha', 'Zeta']);
    expect(groups[0].folders.map((f) => f.name)).toEqual(['helm', 'monitoring', 'general']);
    expect(groups[1].folders[0].items.map((p) => p.handle)).toEqual(['a/first']);
  });

  it('puts retired practices apart, last', () => {
    const { groups, retired } = groupPractices([practice({ id: '1' }), practice({ id: '2', handle: 'old/one', status: 'retired' })], names);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(1);
    expect(retired.map((p) => p.handle)).toEqual(['old/one']);
  });

  it('is amber only for a version waiting for the viewer to approve', () => {
    const draft = [version({ version: 2 })];
    expect(waitingVersion({ canApprove: true, drafts: draft })).toBe(2);
    expect(waitingVersion({ canApprove: false, drafts: draft })).toBeUndefined();
    expect(waitingVersion({ canApprove: true, drafts: [] })).toBeUndefined();
  });
});

describe('check sentences', () => {
  it('reads each kind in words', () => {
    expect(checkSentence({ kind: 'pathExists', when: 'deploy/**', glob: 'deploy/helm/*/Chart.yaml' })).toBe('When a file changes under `deploy/**`, a file matching `deploy/helm/*/Chart.yaml` must exist');
    expect(checkSentence({ kind: 'pathExists', glob: 'docs/**' })).toBe('A file matching `docs/**` must exist');
    expect(checkSentence({ kind: 'pathAbsent', glob: '**/.env', unless: '**/.env.example' })).toBe('No file matching `**/.env` may exist, unless it also matches `**/.env.example`');
    expect(checkSentence({ kind: 'fileMatches', glob: '**/*.yaml', pattern: 'kind:' })).toBe('Every file matching `**/*.yaml` must contain `kind:`');
    expect(checkSentence({ kind: 'fileMatches', glob: 'src/**', pattern: 'console.log', absent: true })).toBe('No file matching `src/**` may contain `console.log`');
  });
});

const citation = (over: Partial<PracticeCitation> = {}): PracticeCitation => ({ repo: 'acme/web', sha: 'abc1234def', path: 'deploy/helm/web/Chart.yaml', lines: [1, 4], excerpt: 'apiVersion: v2', verified: true, ...over });
const detail = (over: Partial<PracticeView> = {}, extra: Partial<PracticeDetailResponse> = {}): PracticeDetailResponse => {
  const p = practice(over);
  return { practice: p, versions: [{ ...(p.approved ?? version()), state: 'approved' as const }], applications: [], conflicts: [], ...extra };
};

describe('the card', () => {
  it('shows verified and unverified citations, check sentences and the strength pill', () => {
    const approved = version({
      checks: [{ kind: 'pathExists', when: 'deploy/**', glob: 'deploy/helm/*/Chart.yaml' }, { kind: 'fileMatches', glob: '**/*.yaml', pattern: 'kind:', absent: true }],
      citations: [citation(), citation({ verified: false, path: 'README.md', sha: 'fff0000' })],
    });
    const html = renderToStaticMarkup(createElement(PracticeCard, { detail: detail({ approved }) }));
    expect(html).toContain('Required');
    expect(html).toContain('Organization');
    expect(html).toContain('Approved');
    expect(html).toContain('verified at abc1234');
    expect(html).toContain('not verified: read by a person’s tools, not by a flow');
    expect(html).toContain('a file matching');
    expect(html).toContain('deploy/helm/*/Chart.yaml');
    expect(html).toContain('may contain');
    expect(html).toContain('apiVersion: v2');
  });

  it('shows the banner and Review for a waiting version, only to someone who may approve it', () => {
    const drafts = [version({ version: 2, tainted: true, source: 'learned' })];
    const approver = renderToStaticMarkup(createElement(PracticeCard, { detail: detail({ drafts }), onReview: () => {} }));
    expect(approver).toContain('Version 2 waits for you');
    expect(approver).toContain('Review');
    const drafter = renderToStaticMarkup(createElement(PracticeCard, { detail: detail({ drafts, canApprove: false }), onReview: () => {} }));
    expect(drafter).not.toContain('waits for you');
    expect(drafter).toContain('waits for an admin');
    expect(drafter).not.toContain('Retire');
  });

  it('shows Edit with canDraft and Retire with canApprove', () => {
    const both = renderToStaticMarkup(createElement(PracticeCard, { detail: detail(), onEdit: () => {}, onRetire: () => {} }));
    expect(both).toContain('Edit');
    expect(both).toContain('Retire');
    const neither = renderToStaticMarkup(createElement(PracticeCard, { detail: detail({ canDraft: false, canApprove: false }), onEdit: () => {}, onRetire: () => {} }));
    expect(neither).not.toContain('>Edit<');
    expect(neither).not.toContain('Retire');
  });

  it('links an application to its Run Trace and shows the version timeline', () => {
    const app: PracticeApplication = { id: 'a1', practiceId: 'prc_a', version: 1, kind: 'check-fail', executionId: 'ex_1', agentId: 'ag_1', at: NOW };
    const html = renderToStaticMarkup(createElement(PracticeCard, { detail: detail({}, { applications: [app] }) }));
    expect(html).toContain('href="/executions/ex_1"');
    expect(html).toContain('Check failed');
    expect(html).toContain('Version 1');
  });

  it('says no agent gets a practice that has no approved version', () => {
    const html = renderToStaticMarkup(createElement(PracticeCard, { detail: detail({ approved: undefined, status: 'draft', approvedVersion: undefined }) }));
    expect(html).toContain('No version is approved yet');
  });
});

describe('the review dialog', () => {
  const conflict = { id: 'prc_b', handle: 'helm/other', title: 'Other', level: 'org' as const, version: 3, overlap: 'topic helm' };
  it('keeps Approve off until every overlap has an answer and a tainted version is read', () => {
    expect(approveBlockers({ tainted: false, reviewed: false, conflicts: [], answers: {} })).toEqual([]);
    expect(approveBlockers({ tainted: true, reviewed: false, conflicts: [], answers: {} })).toHaveLength(1);
    expect(approveBlockers({ tainted: true, reviewed: true, conflicts: [conflict], answers: {} })).toHaveLength(1);
    expect(approveBlockers({ tainted: true, reviewed: true, conflicts: [conflict], answers: { prc_b: 'keep' } })).toEqual([]);
  });

  it('sends the version, the tick for a tainted one and an answer for each overlap', () => {
    expect(approveBody({ version: 2, tainted: false }, { reviewed: true, conflicts: [], answers: {} })).toEqual({ version: 2 });
    expect(approveBody({ version: 2, tainted: true }, { reviewed: true, conflicts: [conflict], answers: { prc_b: 'supersede', gone: 'keep' } })).toEqual({
      version: 2,
      reviewedSources: true,
      conflicts: { prc_b: 'supersede' },
    });
  });

  it('adds the conflicts a 409 names, once each', () => {
    const said = reviewError({ status: 409, message: 'Overlaps', body: { code: 'practice_conflict', conflicts: [conflict] } });
    expect(said.message).toContain('Supersede or Keep both');
    expect(mergeConflicts([], said.conflicts)).toEqual([conflict]);
    expect(mergeConflicts([conflict], said.conflicts)).toHaveLength(1);
    expect(reviewError({ status: 409, message: 'x', body: { code: 'practice_needs_review' } }).message).toBe('Read its rules against their sources first.');
    expect(reviewError({ status: 500, message: 'Boom' }).message).toBe('Boom');
  });

  it('wants a reason of 10 to 500 characters to reject', () => {
    expect(reasonValid('too short')).toBe(false);
    expect(reasonValid('this is long enough')).toBe(true);
    expect(reasonValid('x'.repeat(501))).toBe(false);
  });

  it('shows a new practice as all added, and a change against the approved version', () => {
    const added = versionDiff(undefined, version());
    expect(added.flatMap((h) => h.lines).every((l) => l.type === 'add')).toBe(true);
    const changed = versionDiff(version(), version({ version: 2, summary: 'Charts live in charts/.' }));
    const lines = changed.flatMap((h) => h.lines);
    expect(lines.some((l) => l.type === 'del' && l.text.includes('deploy/helm'))).toBe(true);
    expect(lines.some((l) => l.type === 'add' && l.text.includes('charts/'))).toBe(true);
  });
});

describe('the form', () => {
  const ok = () => ({ ...emptyForm(), handle: 'helm/chart-location', title: 'Charts', summary: 'One chart per service.', body: 'Rules.' });
  it('chooses the version an edit starts from', () => {
    expect(editBase([{ state: 'rejected' as const, n: 2 }, { state: 'approved' as const, n: 1 }])?.n).toBe(1);
    expect(editBase([{ state: 'rejected' as const, n: 2 }])?.n).toBe(2);
  });
  it('accepts a minimal practice, and needs a body', () => {
    expect(validatePracticeForm(ok())).toEqual({});
    expect(validatePracticeForm({ ...ok(), body: '  ' }).body).toBeDefined();
    expect(validatePracticeForm({ ...ok(), checks: [{ ...emptyCheck('fileMatches'), glob: '*.md', pattern: '  ' }] }).checks).toBeDefined();
  });
  it('checks the handle, the level and project, the title and the summary', () => {
    expect(validatePracticeForm({ ...ok(), handle: 'Helm' }).handle).toBeDefined();
    expect(validatePracticeForm({ ...ok(), handle: 'a/b/c/d' }).handle).toBeDefined();
    expect(validatePracticeForm({ ...ok(), handle: 'a/b/c' }).handle).toBeUndefined();
    expect(validatePracticeForm({ ...ok(), level: 'project' }).projectId).toBeDefined();
    expect(validatePracticeForm({ ...ok(), level: 'project', projectId: 'p1' }).projectId).toBeUndefined();
    expect(validatePracticeForm({ ...ok(), title: ' ' }).title).toBeDefined();
    expect(validatePracticeForm({ ...ok(), title: 'x'.repeat(161) }).title).toBeDefined();
    expect(validatePracticeForm({ ...ok(), summary: 'x'.repeat(301) }).summary).toBeDefined();
    expect(validatePracticeForm({ ...ok(), summary: 'x'.repeat(300) }).summary).toBeUndefined();
    expect(validatePracticeForm({ ...ok(), body: 'x'.repeat(4001) }).body).toBeDefined();
  });
  it('checks topics, repositories and paths', () => {
    expect(validatePracticeForm({ ...ok(), topics: ['Helm Charts'] }).topics).toBeDefined();
    expect(validatePracticeForm({ ...ok(), topics: Array.from({ length: 11 }, (_, i) => `t${i}`) }).topics).toBeDefined();
    expect(validatePracticeForm({ ...ok(), repos: 'acme/web\nnot a repo' }).repos).toBeDefined();
    expect(validatePracticeForm({ ...ok(), repos: 'acme/web\nacme/api' }).repos).toBeUndefined();
    expect(validatePracticeForm({ ...ok(), paths: 'x'.repeat(201) }).paths).toBeDefined();
  });
  it('checks each check row', () => {
    expect(validatePracticeForm({ ...ok(), checks: [emptyCheck()] }).checks).toContain('Check 1');
    expect(validatePracticeForm({ ...ok(), checks: [{ ...emptyCheck('fileMatches'), glob: '**/*.yaml' }] }).checks).toContain('text');
    expect(validatePracticeForm({ ...ok(), checks: [{ ...emptyCheck('fileMatches'), glob: '**/*.yaml', pattern: '(' }] }).checks).toContain('valid');
    expect(validatePracticeForm({ ...ok(), checks: [{ ...emptyCheck('pathExists'), glob: 'a/**' }] }).checks).toBeUndefined();
  });
  it('lets an edit keep its handle and project, and builds the request bodies', () => {
    expect(validatePracticeForm({ ...ok(), handle: '', level: 'project' }, { editing: true })).toEqual({});
    const input = draftInput({ ...ok(), topics: ['helm', ' helm '], repos: 'acme/web\nacme/web', paths: 'deploy/**', checks: [{ ...emptyCheck('pathAbsent'), glob: '**/.env', other: '**/.env.example' }] });
    expect(input).toMatchObject({ handle: 'helm/chart-location', level: 'org', topics: ['helm'], repos: ['acme/web'], paths: ['deploy/**'], checks: [{ kind: 'pathAbsent', glob: '**/.env', unless: '**/.env.example' }] });
    expect(input).not.toHaveProperty('projectId');
  });
});
