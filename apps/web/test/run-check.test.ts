/**
 * Whether a test run passed, for Spotlight's "Test and fix" (lib/shared/run-check.ts): a failed node, an execution
 * that didn't succeed, and a run where every branch ended with no items don't pass; an agent's tools are not steps.
 * Steps that run but do nothing (a filter without conditions) are found too.
 */
import { describe, expect, it } from 'vitest';
import { checkRun, hollowSteps, multipliedSteps, type CheckedRun } from '@/lib/shared/run-check';

/** Schedule → Fetch → Filter → Post, with a tool on the side. */
const run = (ran: CheckedRun['ran'], extra: Partial<CheckedRun> = {}): CheckedRun => ({
  nodes: [
    { id: 's', name: 'Schedule', sub: false },
    { id: 'f', name: 'Fetch', sub: false },
    { id: 'k', name: 'Filter', sub: false },
    { id: 'p', name: 'Post', sub: false },
    { id: 't', name: 'Calculator', sub: true },
  ],
  edges: [
    { source: 's', target: 'f' },
    { source: 'f', target: 'k' },
    { source: 'k', target: 'p' },
  ],
  ran,
  status: 'success',
  ...extra,
});

describe('test run check', () => {
  it('passes when items reach the end', () => {
    expect(checkRun(run({ s: { items: 1 }, f: { items: 5 }, k: { items: 2 }, p: { items: 2 } }))).toEqual({ passed: true, node: 'Post', summary: '4 steps, 2 items reached “Post”' });
  });

  it('names the node that failed, a step before a tool', () => {
    expect(checkRun(run({ s: { items: 1 }, f: { error: '404 Not Found', items: 0 }, t: { error: 'bad input', items: 0 } }, { status: 'error' }))).toEqual({
      passed: false,
      node: 'Fetch',
      summary: 'failed at “Fetch”: 404 Not Found',
    });
    expect(checkRun(run({ s: { items: 1 }, t: { error: 'bad input', items: 0 } }))).toMatchObject({ passed: false, node: 'Calculator' });
  });

  it('fails a run that ended badly without a failed node', () => {
    expect(checkRun(run({ s: { items: 1 } }, { status: 'error', error: 'Timed out' }))).toEqual({ passed: false, summary: 'ended with error: Timed out' });
  });

  it('fails a run where items stopped before the end', () => {
    expect(checkRun(run({ s: { items: 1 }, f: { items: 5 }, k: { items: 0 } }))).toEqual({
      passed: false,
      node: 'Filter',
      summary: '“Filter” put out no items, so nothing reached the end of the flow',
    });
    // One branch with items is enough (an If's other branch may well be empty).
    const branches = run({ s: { items: 1 }, f: { items: 1 }, k: { items: 1 }, p: { items: 0 }, x: { items: 1 } }, {});
    branches.nodes.push({ id: 'x', name: 'Log', sub: false });
    branches.edges.push({ source: 'k', target: 'x' });
    expect(checkRun(branches)).toMatchObject({ passed: true, summary: '5 steps, 1 item reached “Log”' });
  });
});

describe('hollow steps', () => {
  it('finds an If or Filter without conditions and a Set without fields', () => {
    expect(
      hollowSteps([
        { name: 'Filter User 1', type: 'core.filter', parameters: { conditions: { condition: [] }, combinator: 'and' } },
        { name: 'Check', type: 'core.if', parameters: { conditions: { condition: [{ left: '{{ $json.a }}', operator: 'equals', right: '1' }] } } },
        { name: 'Format Message', type: 'core.set', parameters: { mode: 'manual', fields: { values: [] }, includeOtherFields: true } },
        { name: 'Raw', type: 'core.set', parameters: { mode: 'raw', fields: { values: [] } } },
        // A node left at its defaults has the default condition.
        { name: 'Fresh filter', type: 'core.filter', parameters: {} },
      ]),
    ).toEqual([
      { node: 'Filter User 1', problem: '“Filter User 1” has no conditions, so it keeps every item' },
      { node: 'Format Message', problem: '“Format Message” sets no fields' },
    ]);
  });
});

describe('multiplied steps', () => {
  it('finds per-item code that put out every item for each one', () => {
    const steps = [
      { id: 'k', name: 'Format List', type: 'core.code', parameters: { mode: 'each' } },
      { id: 'p', name: 'Post', type: 'core.code', parameters: { mode: 'all' } },
    ];
    const ran = run({ s: { items: 1 }, f: { items: 100 }, k: { items: 1000 }, p: { items: 1 } });
    expect(multipliedSteps(ran, steps)).toEqual([
      { node: 'Format List', problem: '“Format List” runs once per item but put out 1000 items from 100, so its code handles every item each time: use mode “all” to work on all items at once, or return only this item’s result' },
    ]);
    // One result per item, or a single item in: nothing to say.
    expect(multipliedSteps(run({ s: { items: 1 }, f: { items: 10 }, k: { items: 10 } }), steps)).toEqual([]);
    expect(multipliedSteps(run({ s: { items: 1 }, f: { items: 1 }, k: { items: 5 } }), steps)).toEqual([]);
  });
});
