/** The analyst's chart (lib/shared/analyst-chart.ts): numbers come from the tool results, one test per Usage tool shape. */
import { describe, expect, it } from 'vitest';
import { analystChart, chartHeading, isAnalyst, runsHref, sourcesOf, splitAnswer } from '@/lib/shared/analyst-chart';
import { analystConfig } from '@/lib/server/brain/analyst';

const row = (key: string, o: Record<string, unknown> = {}) => ({ key, count: 1, failures: 0, durationAvgMs: 0, durationMaxMs: 0, items: 0, tokens: 0, cost: 0, ...o });
const report = (groupBy: string, rows: unknown[], totals: Record<string, unknown> = {}) => ({ from: '2026-10-25T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z', groupBy, rows, totals: { count: 0, failures: 0, cost: 0, ...totals } });

describe('analystChart', () => {
  it('draws usage_report by day, in time order, as cost', () => {
    const chart = analystChart([{ tool: 'usage_report', input: { groupBy: 'day' }, output: report('day', [row('2026-10-31', { cost: 0.5 }), row('2026-10-30', { cost: 0.25 })], { cost: 0.75 }) }]);
    expect(chart).toMatchObject({ metric: 'cost', groupBy: 'day', total: 0.75, period: 'This week' });
    expect(chart!.points.map((p) => [p.label, p.value])).toEqual([['10-30', 0.25], ['10-31', 0.5]]);
  });
  it('falls back to failures, then counts, and ranks other groups by size', () => {
    const failures = analystChart([{ tool: 'usage_report', output: report('workflow', [row('a', { label: 'A', failures: 1 }), row('b', { label: 'B', failures: 4 })], { failures: 5 }) }]);
    expect(failures).toMatchObject({ metric: 'failures', metricLabel: 'Failures' });
    expect(failures!.points.map((p) => p.label)).toEqual(['B', 'A']);
    const counts = analystChart([{ tool: 'usage_report', output: report('kind', [row('run.finished', { count: 9 }), row('ai.call', { count: 3 })]) }]);
    expect(counts).toMatchObject({ metric: 'count' });
  });
  it('reads JSON text, ignores a single group and an all-zero report', () => {
    expect(analystChart([{ tool: 'usage_report', output: JSON.stringify(report('day', [row('2026-10-30', { cost: 1 }), row('2026-10-31', { cost: 2 })])) }])).toBeDefined();
    expect(analystChart([{ tool: 'usage_report', output: report('day', [row('2026-10-30', { cost: 1 })]) }])).toBeUndefined();
    expect(analystChart([{ tool: 'usage_report', output: report('day', [row('a', { count: 0 }), row('b', { count: 0 })]) }])).toBeUndefined();
  });
  it('takes the scope from workflow_knowledge and a stated budget', () => {
    const chart = analystChart([
      { tool: 'usage_report', output: report('day', [row('2026-10-30', { cost: 1 }), row('2026-10-31', { cost: 2 })]) },
      { tool: 'workflow_knowledge', input: { workflowId: 'wf_1' }, output: { name: 'Tech Review Workflow', outline: '', profile: { budget: 2.5 }, facts: [], proposals: [] } },
    ]);
    expect(chart).toMatchObject({ budget: 2.5, scope: { name: 'Tech Review Workflow', workflowId: 'wf_1' } });
    expect(chartHeading(chart!)).toBe('This week · Tech Review Workflow');
    expect(runsHref(chart)).toBe('/executions?workflowId=wf_1');
    expect(runsHref()).toBe('/executions');
  });
  it('has no chart when only facts, suggestions or workflow knowledge came back', () => {
    expect(analystChart([{ tool: 'search_facts', output: { facts: [{ id: 'f', text: 'x' }] } }])).toBeUndefined();
    expect(analystChart([{ tool: 'open_suggestions', output: { proposals: [{ id: 'p', title: 'x' }] } }])).toBeUndefined();
    expect(analystChart([{ tool: 'workflow_knowledge', input: { workflowId: 'w' }, output: { name: 'W', facts: [], proposals: [] } }])).toBeUndefined();
    expect(analystChart([])).toBeUndefined();
  });
});

describe('analyst helpers', () => {
  it('recognises the analyst by its tools and lists the sources they read', () => {
    const tools = analystConfig().tools as Array<{ type: string; name: string; nodeType: string }>;
    expect(isAnalyst(tools)).toBe(true);
    expect(isAnalyst([{ type: 'node', name: 'x', nodeType: 'core.http' }])).toBe(false);
    expect(sourcesOf(tools.map((t) => t.name))).toEqual(['runs', 'usage', 'facts', 'suggestions']);
    expect(sourcesOf(['usage_report', 'search_facts'])).toEqual(['runs', 'usage', 'facts']);
  });
  it('splits the answer from up to two bullet drivers', () => {
    expect(splitAnswer('Cost doubled.\n- **Big prompt** in Review\n- Retries\n- Third')).toEqual({ answer: 'Cost doubled.', drivers: ['Big prompt in Review', 'Retries'] });
  });
});
