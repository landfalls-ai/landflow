/** The waive page (docs/practices.md#waiving-from-a-flow): what it reads off a failed run, the reason's limits and its first markup. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { failuresFor, reasonProblem, WaiveForm } from '@/components/practices/waive-form';

const run = (description?: string) => ({
  workflowId: 'wf_1',
  status: 'error',
  runData: { 'Check Practices': [{ status: 'error', error: { message: 'Required practices failed: sec/no-secrets, helm/charts. Fix', ...(description && { description }) } }], After: [] },
});

describe('failuresFor', () => {
  const lines = 'sec/no-secrets@2: pathAbsent secrets/**: changed files match secrets/** (secrets/key.txt)\nhelm/charts@1: pathExists charts/**: no changed file matches charts/**';
  it('gives the lines of this practice', () => {
    expect(failuresFor(run(lines), 'helm/charts')).toEqual(['helm/charts@1: pathExists charts/**: no changed file matches charts/**']);
  });
  it('gives every line when none names it, and nothing for another kind of failure', () => {
    expect(failuresFor(run(lines), 'other/rule')).toHaveLength(2);
    expect(failuresFor({ workflowId: 'w', status: 'error', runData: { Code: [{ status: 'error', error: { message: 'boom' } }] } }, 'sec/no-secrets')).toEqual([]);
    expect(failuresFor(undefined, 'x')).toEqual([]);
  });
});

describe('reasonProblem', () => {
  it('asks for 10 to 500 characters', () => {
    expect(reasonProblem('short')).toMatch(/at least 10/);
    expect(reasonProblem('   padded   ')).toMatch(/at least 10/);
    expect(reasonProblem('The key file is a test fixture')).toBeUndefined();
    expect(reasonProblem('x'.repeat(501))).toMatch(/At most 500/);
  });
});

describe('the page', () => {
  it('renders a first frame without a practice or a run', () => {
    expect(renderToStaticMarkup(createElement(WaiveForm, { practiceId: 'prc_1', executionId: 'ex_1' }))).toContain('Waive a practice');
  });
});
