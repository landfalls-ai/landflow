/**
 * The Runs list: repeated failures fold into one row, the filters sit in the URL, the old pages redirect, and the
 * re-run menu has two words (docs/run-trace.md#the-runs-list). Logic is in pure functions; the menu words are read from
 * `meta.tsx`.
 */
import { describe, expect, it } from 'vitest';
import type { ExecutionSummary } from '../src/lib/shared/types';
import { failureKey, groupFailures, groupTitle } from '../src/components/runs/failure-groups';
import { NO_FILTERS, compareRedirect, executionsRedirect, filtersQuery, matchesFilters, moreCount, needsJournal, parseFilters, runsHref } from '../src/components/runs/runs-query';
import { RERUN_CHOICES, RERUN_MENU_WORDS, RERUN_WORD, RETRY_CHOICES, RETRY_LABEL } from '../src/components/executions/meta';

let n = 0;
const run = (over: Partial<ExecutionSummary> = {}): ExecutionSummary => ({
  id: `ex_${++n}`,
  workflowId: 'wf_a',
  workflowName: 'Post digest',
  mode: 'manual',
  status: 'success',
  startedAt: '2026-11-10T10:00:00.000Z',
  durationMs: 100,
  nodesRun: 2,
  ...over,
});
const failed = (message = 'no credential', over: Partial<ExecutionSummary> = {}) => run({ status: 'error', error: { message, nodeId: 'n_slack', nodeName: 'Post to Slack' }, ...over });

describe('groupFailures', () => {
  it('folds neighbours that failed at one node with one message', () => {
    const rows = groupFailures([failed(), failed(), failed()]);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.kind).toBe('group');
    if (row.kind === 'group') {
      expect(row.runs).toHaveLength(3);
      expect(groupTitle(row)).toBe('Failed ×3 · Post to Slack: no credential');
    }
  });

  it('keeps a different message, node or workflow apart', () => {
    expect(groupFailures([failed('no credential'), failed('timeout')]).map((r) => r.kind)).toEqual(['run', 'run']);
    expect(groupFailures([failed(), failed('no credential', { error: { message: 'no credential', nodeId: 'n_other', nodeName: 'Other' } })]).map((r) => r.kind)).toEqual(['run', 'run']);
    expect(groupFailures([failed(), failed('no credential', { workflowId: 'wf_b' })]).map((r) => r.kind)).toEqual(['run', 'run']);
  });

  it('ends a group at a success, and counts each side on its own', () => {
    const rows = groupFailures([failed(), failed(), run(), failed(), failed(), failed()]);
    expect(rows.map((r) => (r.kind === 'group' ? r.runs.length : 1))).toEqual([2, 1, 3]);
  });

  it('keeps the group key when a newer matching failure arrives', () => {
    const older = [failed(), failed(), failed()];
    const [before] = groupFailures(older);
    const [after] = groupFailures([failed(), ...older]);
    expect(before.kind === 'group' && after.kind === 'group' && before.key === after.key).toBe(true);
    if (after.kind === 'group') expect(after.runs).toHaveLength(4);
  });

  it('names the failure a group is opened by, which stays when its oldest run leaves', () => {
    const runs = [failed(), failed(), failed()];
    const [before] = groupFailures(runs);
    const [after] = groupFailures(runs.slice(0, 2));
    expect(before.kind === 'group' && after.kind === 'group').toBe(true);
    if (before.kind === 'group' && after.kind === 'group') {
      expect(after.key).not.toBe(before.key);
      expect(after.failure).toBe(before.failure);
      expect(before.failure).toBe(failureKey(runs[0]));
    }
  });

  it('leaves successes and a lone failure as runs, and a run without an error has no key', () => {
    expect(groupFailures([run(), run(), failed()]).every((r) => r.kind === 'run')).toBe(true);
    expect(failureKey(run({ status: 'error' }))).toBeUndefined();
    expect(failureKey(run())).toBeUndefined();
  });
});

describe('the filters and the URL', () => {
  it('round-trips every filter', () => {
    const f = { q: 'slack', status: 'error', workflowId: 'wf_a', actor: 'Developer', tool: 'Bash', from: '2026-11-01', to: '2026-11-09', failedSteps: true, failedCheck: 'lint' };
    expect(parseFilters(new URLSearchParams(filtersQuery(f)))).toEqual(f);
    expect(runsHref(f)).toBe(`/runs?${filtersQuery(f)}`);
  });

  it('is /runs with nothing set, and ignores what it does not know', () => {
    expect(runsHref(NO_FILTERS)).toBe('/runs');
    expect(parseFilters(new URLSearchParams('foo=1'))).toEqual(NO_FILTERS);
    expect(parseFilters(new URLSearchParams('status=waiting')).status).toBe('waiting');
  });

  it('counts More filters and knows which need the journal', () => {
    expect(moreCount({ ...NO_FILTERS, q: 'x', status: 'error' })).toBe(0);
    expect(moreCount({ ...NO_FILTERS, actor: 'a', from: '2026-11-01', failedSteps: true })).toBe(3);
    expect(needsJournal({ ...NO_FILTERS, from: '2026-11-01' })).toBe(false);
    expect(needsJournal({ ...NO_FILTERS, tool: 'Bash' })).toBe(true);
  });

  it('matches the search box on workflow, error text and node, and status, workflow and dates', () => {
    const r = failed('no credential');
    expect(matchesFilters(r, { ...NO_FILTERS, q: 'DIGEST' })).toBe(true);
    expect(matchesFilters(r, { ...NO_FILTERS, q: 'credential' })).toBe(true);
    expect(matchesFilters(r, { ...NO_FILTERS, q: 'slack' })).toBe(true);
    expect(matchesFilters(r, { ...NO_FILTERS, q: 'nothing' })).toBe(false);
    expect(matchesFilters(r, { ...NO_FILTERS, status: 'success' })).toBe(false);
    expect(matchesFilters(r, { ...NO_FILTERS, workflowId: 'wf_b' })).toBe(false);
    expect(matchesFilters(r, { ...NO_FILTERS, from: '2026-11-10', to: '2026-11-10' })).toBe(true);
    expect(matchesFilters(r, { ...NO_FILTERS, from: '2026-11-11' })).toBe(false);
  });
});

describe('the old addresses', () => {
  it('sends /executions to /runs with its query, and ?id= to that run', () => {
    expect(executionsRedirect({})).toBe('/runs');
    expect(executionsRedirect({ workflowId: 'x' })).toBe('/runs?workflowId=x');
    expect(executionsRedirect({ status: 'waiting' })).toBe('/runs?status=waiting');
    expect(executionsRedirect({ id: 'y' })).toBe('/runs/y');
    expect(executionsRedirect({ id: 'a/b' })).toBe('/runs/a%2Fb');
  });

  it('sends a compare without two runs back to the list', () => {
    expect(compareRedirect({})).toBe('/runs');
    expect(compareRedirect({ a: 'x' })).toBe('/runs');
    expect(compareRedirect({ b: 'x' })).toBe('/runs');
    expect(compareRedirect({ a: 'x', b: 'y' })).toBeUndefined();
  });
});

describe('the re-run words', () => {
  it('are exactly two, with the workflow choices under them', () => {
    expect(RERUN_MENU_WORDS).toEqual(['Retry from failed step', 'Re-run']);
    expect(RETRY_LABEL).toBe('Retry from failed step');
    expect(RERUN_WORD).toBe('Re-run');
    expect(RETRY_CHOICES.map((c) => c.label)).toContain('With the saved workflow');
    expect(RERUN_CHOICES.map((c) => c.label)).toEqual(['With the saved workflow', 'With the workflow as it ran']);
  });
});
