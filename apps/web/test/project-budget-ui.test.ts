/** A project's AI budget on screen: the actions a row offers, the bar, the fetch helpers and the markup (contracts/w9/budget-api.md). */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { actionsFor } from '../src/components/run-trace/needs-you-actions';
import { BudgetRow } from '../src/components/run-trace/run-lists';
import { ProjectBudgetCardView } from '../src/components/projects/project-budget-card';
import { barPercent, barTone, budgetDirty, budgetInput, fetchBudget, fieldsFrom, formatUsd, runIncidentAction, saveBudget } from '../src/lib/client/project-budget-api';
import type { NeedsYouRow } from '../src/lib/client/run-trace';
import type { ProjectBudgetView } from '../src/lib/shared/project-budget';

const stopView: ProjectBudgetView = {
  budget: { projectId: 'prj_billing01', monthlyUsd: 50, warnPercent: 80, hardStop: true, ownerId: 'usr_ana', updatedAt: '2026-11-15T09:00:00.000Z', updatedBy: 'usr_admin' },
  month: '2026-11',
  usedUsd: 50.12,
  unpricedCalls: 14,
  percent: 100,
  paused: true,
  incidents: [
    { id: 'pbi_stop1', projectId: 'prj_billing01', month: '2026-11', kind: 'stop', status: 'open', usedUsd: 50.12, budgetUsd: 50, createdAt: '2026-11-15T10:00:00.000Z' },
    { id: 'pbi_warn1', projectId: 'prj_billing01', month: '2026-11', kind: 'warn', status: 'open', usedUsd: 40.3, budgetUsd: 50, createdAt: '2026-11-14T16:00:00.000Z' },
  ],
  canEdit: false,
  canResume: true,
  canAsk: true,
  capId: 'project:prj_billing01:month:cost',
};
const emptyView: ProjectBudgetView = { month: '2026-11', usedUsd: 3.5, unpricedCalls: 2, percent: 0, paused: false, incidents: [], canEdit: true, canResume: true, canAsk: false };
const members = [{ userId: 'usr_ana', name: 'Ana Example', email: 'ana@example.test', role: 'editor' as const, createdAt: '2026-11-01T00:00:00.000Z' }];

const row = (patch: Partial<NeedsYouRow>): NeedsYouRow => ({
  executionId: '',
  workflowId: '',
  workflowName: '',
  kind: 'budget',
  projectId: 'prj_billing01',
  incidentId: 'pbi_stop1',
  incidentKind: 'stop',
  href: '/projects/prj_billing01?tab=settings#budget',
  title: 'Project “Billing revamp” paused: AI budget reached ($50.12 of $50.00)',
  detail: 'Paid AI calls in this project are refused until someone resumes or raises the budget. Local models still run.',
  canRaise: false,
  canResume: true,
  since: '2026-11-15T10:00:00.000Z',
  ...patch,
});

const ids = (r: Partial<NeedsYouRow>) => actionsFor(row(r)).map((a) => a.id);

describe('actionsFor', () => {
  it('a stop: resume and raise by rights, always open', () => {
    expect(ids({ canResume: true, canRaise: true })).toEqual(['resume', 'raise', 'open']);
    expect(ids({ canResume: true, canRaise: false })).toEqual(['resume', 'open']);
    expect(ids({ canResume: false, canRaise: false })).toEqual(['open']);
    expect(actionsFor(row({ canRaise: true }))[0].label).toBe('Resume this month');
  });
  it('a warning: dismiss for those who may resume', () => {
    expect(ids({ incidentKind: 'warn', canResume: true, canRaise: true })).toEqual(['dismiss', 'open']);
    expect(ids({ incidentKind: 'warn', canResume: false })).toEqual(['open']);
  });
  it('is empty for every other kind', () => {
    for (const kind of ['approval', 'form', 'question', 'gate', 'check'] as const) expect(ids({ kind })).toEqual([]);
  });
});

describe('the bar', () => {
  it('clamps its fill and picks its tone', () => {
    expect(barPercent({ percent: 140 })).toBe(100);
    expect(barPercent({ percent: -2 })).toBe(0);
    const budget = stopView.budget;
    expect(barTone({ percent: 79, paused: false, budget })).toBe('ok');
    expect(barTone({ percent: 80, paused: false, budget })).toBe('warn');
    expect(barTone({ percent: 99, paused: false, budget })).toBe('warn');
    expect(barTone({ percent: 100, paused: false, budget })).toBe('full');
    expect(barTone({ percent: 10, paused: true, budget })).toBe('full');
    expect(barTone({ percent: 0, paused: false })).toBe('ok');
  });
  it('formats dollars and checks the fields', () => {
    expect(formatUsd(50.1)).toBe('$50.10');
    expect(budgetInput({ monthly: '75', warn: '90', hardStop: true, ownerId: '' })).toEqual({ input: { monthlyUsd: 75, warnPercent: 90, hardStop: true, ownerId: null } });
    expect(budgetInput({ monthly: '', warn: '80', hardStop: false, ownerId: 'usr_ana' })).toEqual({ input: { monthlyUsd: 0, warnPercent: 80, hardStop: false, ownerId: 'usr_ana' } });
    expect('error' in budgetInput({ monthly: '-1', warn: '80', hardStop: false, ownerId: '' })).toBe(true);
    expect('error' in budgetInput({ monthly: '5', warn: '101', hardStop: false, ownerId: '' })).toBe(true);
    expect(fieldsFrom(stopView)).toEqual({ monthly: '50', warn: '80', hardStop: true, ownerId: 'usr_ana' });
    expect(fieldsFrom(emptyView)).toEqual({ monthly: '', warn: '80', hardStop: false, ownerId: '' });
  });
  it('with no budget, Warn at, Hard stop or the owner alone are nothing to save', () => {
    const empty = fieldsFrom(emptyView);
    expect(budgetDirty(empty, emptyView)).toBe(false);
    expect(budgetDirty({ ...empty, warn: '60' }, emptyView)).toBe(false);
    expect(budgetDirty({ ...empty, hardStop: true, ownerId: 'usr_ana' }, emptyView)).toBe(false);
    expect(budgetDirty({ ...empty, monthly: '0', hardStop: true }, emptyView)).toBe(false);
    expect(budgetDirty({ ...empty, monthly: '5' }, emptyView)).toBe(true);
    const saved = fieldsFrom(stopView);
    expect(budgetDirty(saved, stopView)).toBe(false);
    expect(budgetDirty({ ...saved, warn: '60' }, stopView)).toBe(true);
    expect(budgetDirty({ ...saved, monthly: '' }, stopView)).toBe(true);
  });
});

describe('the fetch helpers', () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = (body: unknown) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };
  it('read the view and send the contract bodies', async () => {
    const f = stub(stopView);
    expect(await fetchBudget('prj_billing01')).toEqual(stopView);
    expect(f.mock.calls[0]).toEqual(['/api/projects/prj_billing01/budget', expect.objectContaining({ cache: 'no-store' })]);
    await saveBudget('prj_billing01', { monthlyUsd: 60 });
    expect(f.mock.calls[1]).toEqual(['/api/projects/prj_billing01/budget', expect.objectContaining({ method: 'PUT', body: '{"monthlyUsd":60}' })]);
    await runIncidentAction('prj_billing01', 'pbi_stop1', { action: 'raise', monthlyUsd: 80 });
    expect(f.mock.calls[2]).toEqual(['/api/projects/prj_billing01/budget/incidents/pbi_stop1', expect.objectContaining({ method: 'POST', body: '{"action":"raise","monthlyUsd":80}' })]);
  });
});

describe('the card', () => {
  const card = (view: ProjectBudgetView) => renderToStaticMarkup(createElement(ProjectBudgetCardView, { projectId: 'prj_billing01', view, members, fields: fieldsFrom(view) }));
  it('with no budget: "No budget", and empty fields for an admin', () => {
    const html = card(emptyView);
    expect(html).toContain('id="budget"');
    expect(html).toContain('No budget');
    expect(html).toContain('aria-label="Monthly budget in dollars"');
    expect(html).toContain('2 calls to local models (not counted)');
    expect(html).not.toContain('Ask for more');
  });
  it('a paused budget as a viewer who can resume and ask', () => {
    const html = card(stopView);
    expect(html).toContain('Paused');
    expect(html).toContain('bg-rd');
    expect(html).toContain('$50.12 of $50.00');
    expect(html).toContain('14 calls to local models (not counted)');
    expect(html).toContain('Resume this month');
    expect(html).not.toContain('Raise budget');
    expect(html).toContain('Dismiss');
    expect(html).toContain('Ask for more…');
    expect(html).toContain('See it on Insights → AI');
    expect(html).not.toContain('Monthly budget in dollars');
    expect(html).toContain('The project’s admins change this.');
  });
  it('an admin sees the fields, the hard stop words and Raise', () => {
    const html = card({ ...stopView, canEdit: true });
    expect(html).toContain('When on, this project’s paid AI calls stop at the budget until someone resumes them. Local models never stop.');
    expect(html).toContain('Raise budget…');
    expect(html).toContain('Ana Example');
  });
  it('with no budget, changing only Warn at or Hard stop shows no Save', () => {
    const fields = { ...fieldsFrom(emptyView), warn: '60', hardStop: true };
    const html = renderToStaticMarkup(createElement(ProjectBudgetCardView, { projectId: 'prj_billing01', view: emptyView, members, fields }));
    expect(html).not.toContain('>Save<');
    expect(html).not.toContain('Discard');
    const withAmount = renderToStaticMarkup(createElement(ProjectBudgetCardView, { projectId: 'prj_billing01', view: emptyView, members, fields: { ...fields, monthly: '5' } }));
    expect(withAmount).toContain('>Save<');
    expect(withAmount).toContain('Discard');
  });
  it('a warning only: not paused, amber bar', () => {
    const html = card({ ...stopView, paused: false, percent: 85, incidents: [stopView.incidents[1]] });
    expect(html).not.toContain('Paused');
    expect(html).toContain('bg-warn');
    expect(html).not.toContain('bg-rd');
  });
});

describe('a budget row', () => {
  const html = (r: NeedsYouRow) => renderToStaticMarkup(createElement(BudgetRow, { item: r, onDone: () => undefined }));
  it('links to its href and carries its buttons', () => {
    const out = html(row({ canRaise: true }));
    expect(out).toContain('href="/projects/prj_billing01?tab=settings#budget"');
    expect(out).toContain('AI budget');
    expect(out).toContain('Resume this month');
    expect(out).toContain('Raise budget…');
    expect(out).toContain('Open project');
    expect(out).toContain('max-md:min-h-[44px]');
  });
  it('a warning has Dismiss, not Resume', () => {
    const out = html(row({ incidentKind: 'warn', title: 'Project “Billing revamp” used 80% of its AI budget ($40.30 of $50.00)' }));
    expect(out).toContain('Dismiss');
    expect(out).not.toContain('Resume this month');
  });
});
