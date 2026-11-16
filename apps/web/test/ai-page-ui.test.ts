/**
 * The AI page's trend, movers and drill sheet (docs/llm-gateway.md, "The AI page"): the pure helpers (series and stack to
 * chart points, empty days, movers' order, filters to the query and back, the custom range's limits) and the markup of
 * the sheet's lists from a fixture. Hidden runs are a count and a sum, never a name; no prompt text anywhere.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VIEW,
  applyFilterHref,
  drillable,
  drillQuery,
  fillDays,
  filterChips,
  hiddenLine,
  moverLists,
  momentLabel,
  parseView,
  previousRange,
  rangeDays,
  rangeProblem,
  reportQuery,
  stackColor,
  stackColumns,
  stackScopeNote,
  tipLeft,
  trendPoints,
  viewParams,
  viewReady,
  withoutFilter,
  type AiView,
} from '@/lib/client/ai-console';
import { AI_SPEND_MAX_DAYS, type AiSpendPoint, type AiSpendRun, type AiSpendStack } from '@/lib/shared/ai-spend';
import { AiMovers } from '@/components/insights/ai-movers';
import { AiTrend } from '@/components/insights/ai-trend';
import { DrillCalls, DrillRuns } from '@/components/insights/ai-drill';

const point = (at: string, cost: number, inputTokens = 0, outputTokens = 0): AiSpendPoint => ({ at, cost, inputTokens, outputTokens, cacheReadTokens: 0, calls: cost > 0 ? 1 : 0 });
const search = (q: string) => new URLSearchParams(q);

describe('the trend', () => {
  it('fills the days a series leaves out with zeros, in order', () => {
    const filled = fillDays([point('2026-11-03', 2), point('2026-11-05', 1)], '2026-11-02', '2026-11-06');
    expect(filled.map((p) => p.at)).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']);
    expect(filled.map((p) => p.cost)).toEqual([0, 2, 0, 1, 0]);
  });

  it('leaves an hourly series as it came', () => {
    const hours = [point('2026-11-05T10:00:00.000Z', 1), point('2026-11-05T12:00:00.000Z', 2)];
    expect(fillDays(hours, '2026-11-04T12:00:00.000Z', '2026-11-05T12:00:00.000Z')).toBe(hours);
  });

  it('plots cost or all tokens (in and out, cache excluded) per point', () => {
    const series = [point('2026-11-03', 1.5, 100, 40)];
    expect(trendPoints(series, 'cost')).toEqual([{ at: '2026-11-03', value: 1.5 }]);
    expect(trendPoints(series, 'tokens')).toEqual([{ at: '2026-11-03', value: 140 }]);
  });

  it('turns a stack into columns that add up, and ignores a bad number', () => {
    const stack: AiSpendStack = {
      group: 'person',
      scope: 'everyone',
      rows: [{ key: 'u1', label: 'Ada' }, { key: 'other', label: 'Other' }],
      points: [{ at: '2026-11-03', cost: [1, Number.NaN], tokens: [10, 5] }, { at: '2026-11-04', cost: [0, 2], tokens: [0, 7] }],
    };
    expect(stackColumns(stack, 'cost')).toEqual([{ at: '2026-11-03', values: [1, 0], total: 1 }, { at: '2026-11-04', values: [0, 2], total: 2 }]);
    expect(stackColumns(stack, 'tokens').map((c) => c.total)).toEqual([15, 7]);
    expect(stackColor(stack.rows[0], 0)).toBe('var(--viz-1)');
    expect(stackColor(stack.rows[1], 1)).toBe('var(--t3)');
  });

  it('says the person stack is everyone’s and any other group what the viewer can see', () => {
    expect(stackScopeNote('everyone')).toContain('Everyone');
    expect(stackScopeNote('visible')).toBe('What you can see.');
  });

  it('draws the chart’s numbers as a table for a screen reader, and the legend of a stack', () => {
    const series = [point('2026-11-03', 1.5), point('2026-11-04', 0)];
    const html = renderToStaticMarkup(createElement(AiTrend, { report: { series, from: '2026-11-03', to: '2026-11-04', period: 'custom' }, metric: 'cost', onMetric: () => {}, onStack: () => {} }));
    expect(html).toContain('<table class="sr-only">');
    expect(html).toContain('$1.50');
    expect(html).toContain('Per day');
    const stack: AiSpendStack = { group: 'person', scope: 'everyone', rows: [{ key: 'u1', label: 'Ada' }], points: [{ at: '2026-11-03', cost: [1.5], tokens: [9] }, { at: '2026-11-04', cost: [0], tokens: [0] }] };
    const stacked = renderToStaticMarkup(createElement(AiTrend, { report: { series, stack, from: '2026-11-03', to: '2026-11-04', period: 'custom' }, metric: 'cost', stack: 'person', onMetric: () => {}, onStack: () => {} }));
    expect(stacked).toContain('Ada');
    expect(stacked).toContain('Everyone’s spend, by person.');
  });
});

describe('a report from a host that answers the old shape', () => {
  it('draws no trend and no movers instead of throwing', () => {
    const old = { period: '7d', from: '2026-11-10', to: '2026-11-16' } as never;
    expect(() => renderToStaticMarkup(createElement(AiTrend, { report: old, metric: 'cost', onMetric: () => {}, onStack: () => {} }))).not.toThrow();
    expect(renderToStaticMarkup(createElement(AiMovers, { movers: undefined as never }))).toBe('');
  });
});

describe('the trend tooltip', () => {
  it('stays inside the chart whatever its width, and at the left edge when the chart is narrower than it', () => {
    for (const tip of [150, 200, 260]) for (const x of [0, 40, 180, 300, 374]) expect(tipLeft(x, tip, 374) + tip).toBeLessThanOrEqual(374);
    expect(tipLeft(300, 260, 374)).toBe(114);
    expect(tipLeft(10, 150, 374)).toBe(22);
    expect(tipLeft(10, 260, 200)).toBe(0);
  });
});

describe('the movers', () => {
  const mover = (label: string, cost: number, previousCost: number) => ({ group: 'agent' as const, key: label, label, cost, previousCost });
  it('lists rises and falls largest first, five each, and leaves out what did not move', () => {
    const rows = [mover('a', 5, 1), mover('b', 9, 1), mover('c', 1, 6), mover('d', 0, 2), mover('still', 3, 3), ...Array.from({ length: 6 }, (_, i) => mover(`r${i}`, 2 + i / 10, 1))];
    const { rises, falls } = moverLists(rows);
    expect(rises.map((r) => r.label)).toEqual(['b', 'a', 'r5', 'r4', 'r3']);
    expect(falls.map((r) => r.label)).toEqual(['c', 'd']);
    expect(rises[0].delta).toBe(8);
  });

  it('draws nothing without movers, and each list with the groups word and the change', () => {
    expect(renderToStaticMarkup(createElement(AiMovers, { movers: [] }))).toBe('');
    const html = renderToStaticMarkup(createElement(AiMovers, { movers: [mover('Support bot', 6, 1), mover('Digest', 1, 4)] }));
    expect(html).toContain('Support bot');
    expect(html).toContain('+$5.00');
    expect(html).toContain('−$3.00');
  });
});

describe('the view in the URL', () => {
  it('reads a person row’s link as a filter and puts it back, leaving defaults out', () => {
    const view = parseView(search('userId=usr_ada'));
    expect(view).toMatchObject({ period: '7d', group: 'project', filters: { userId: 'usr_ada' } });
    expect(viewParams(view).toString()).toBe('userId=usr_ada');
    expect(viewParams(DEFAULT_VIEW).toString()).toBe('');
  });

  it('round-trips period, range, group, stack, measure, filters and the drilled row', () => {
    const view: AiView = { period: 'custom', from: '2026-09-01', to: '2026-10-15', group: 'credential', filters: { projectId: 'prj_a', model: 'anthropic/claude' }, stack: 'person', metric: 'tokens', drill: { group: 'source', key: 'landflow:landflow' } };
    expect(parseView(viewParams(view))).toEqual(view);
  });

  it('ignores what it does not know and keeps a range only for custom', () => {
    expect(parseView(search('period=1y&group=nope&by=x&from=2026-01-01&drill=bogus:1'))).toEqual(DEFAULT_VIEW);
    expect(parseView(search('period=30d&from=2026-01-01&to=2026-02-01'))).toEqual({ ...DEFAULT_VIEW, period: '30d' });
  });

  it('builds the report’s query from period, range, filters, compare and stack', () => {
    const view: AiView = { ...DEFAULT_VIEW, period: 'custom', from: '2026-09-01', to: '2026-09-30', filters: { workflowId: 'wf_1' }, stack: 'model' };
    expect(reportQuery(view).toString()).toBe('period=custom&from=2026-09-01&to=2026-09-30&workflowId=wf_1');
    expect(reportQuery(view, { compare: true, stack: true }).toString()).toBe('period=custom&from=2026-09-01&to=2026-09-30&workflowId=wf_1&compare=1&stack=model');
    expect(reportQuery({ ...DEFAULT_VIEW, period: '90d' }).toString()).toBe('period=90d');
  });

  it('makes filters chips by the names the report knows, and removes one', () => {
    const view: AiView = { ...DEFAULT_VIEW, filters: { userId: 'usr_ada', surface: 'spotlight' } };
    const chips = filterChips(view.filters, { person: [{ key: 'usr_ada', label: 'Ada' }] });
    expect(chips).toEqual([{ key: 'userId', label: 'Person', value: 'Ada' }, { key: 'surface', label: 'Surface', value: 'spotlight' }]);
    expect(withoutFilter(view, 'userId').filters).toEqual({ surface: 'spotlight' });
  });

  it('asks the sheet for one row of one group with the same period and filters', () => {
    const view: AiView = { ...DEFAULT_VIEW, period: '30d', filters: { projectId: 'prj_a' } };
    expect(drillQuery(view, { group: 'person', key: 'usr_ada' }, { order: 'cost' }).toString()).toBe('period=30d&projectId=prj_a&group=person&key=usr_ada&order=cost');
  });

  it('keeps the view when a person row’s link adds its filter, and leaves other links alone', () => {
    const view: AiView = { ...DEFAULT_VIEW, period: '30d', group: 'person', filters: { projectId: 'prj_a' }, drill: { group: 'person', key: 'x' } };
    expect(applyFilterHref(view, '/insights/ai?userId=usr_ada')).toBe('/insights/ai?period=30d&group=person&projectId=prj_a&userId=usr_ada');
    expect(applyFilterHref(DEFAULT_VIEW, '/insights/ai?userId=usr_ada')).toBe('/insights/ai?userId=usr_ada');
    expect(applyFilterHref(view, '/projects/prj_a')).toBe('/projects/prj_a');
  });

  it('opens a sheet from every row but "Another …" and the tail', () => {
    expect([drillable({ key: 'shared' }), drillable({ key: 'other' }), drillable({ key: 'none' }), drillable({ key: 'prj_a' })]).toEqual([false, false, true, true]);
  });
});

describe('the custom range', () => {
  it('counts both ends and refuses what is not a real range', () => {
    expect(rangeDays('2026-11-01', '2026-11-01')).toBe(1);
    expect(rangeDays('2026-02-28', '2026-03-01')).toBe(2);
    expect(rangeDays('2026-02-30', '2026-03-01')).toBeNaN();
    expect(rangeProblem(undefined, '2026-11-01')).toMatch(/first and the last/);
    expect(rangeProblem('2026-11-05', '2026-11-01')).toMatch(/before the last/);
    expect(rangeProblem('2026-11-01', '2026-11-05', '2026-11-04')).toMatch(/future/);
    expect(rangeProblem('2026-11-01', '2026-11-05', '2026-11-05')).toBeUndefined();
  });

  it(`allows ${AI_SPEND_MAX_DAYS} days and not one more`, () => {
    expect(rangeProblem('2025-10-13', '2026-11-16')).toBeUndefined(); // 400 days
    expect(rangeDays('2025-10-13', '2026-11-16')).toBe(400);
    expect(rangeProblem('2025-10-12', '2026-11-16')).toMatch(/at most 400/);
  });

  it('asks only once a custom range is whole, and finds the days just before one', () => {
    expect(viewReady({ ...DEFAULT_VIEW, period: 'custom', from: '2026-11-01' })).toBe(false);
    expect(viewReady({ ...DEFAULT_VIEW, period: 'custom', from: '2026-11-01', to: '2026-11-07' })).toBe(true);
    expect(viewReady(DEFAULT_VIEW)).toBe(true);
    expect(previousRange('2026-11-03', '2026-11-09')).toEqual({ from: '2026-10-27', to: '2026-11-02' });
    expect(previousRange('2026-03-01', '2026-03-01')).toEqual({ from: '2026-02-28', to: '2026-02-28' });
  });
});

describe('the drill sheet', () => {
  const run = (over: Partial<AiSpendRun>): AiSpendRun => ({ executionId: 'exe_1', label: 'Daily digest', at: '2026-11-03T09:30:00.000Z', href: '/runs/exe_1?tab=spend', inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.42, calls: 3, unpricedCalls: 0, runs: 1, ...over });

  it('says hidden runs as a count and a sum, with no names', () => {
    expect(hiddenLine({ runs: 2, calls: 5, cost: 1.5 })).toBe('2 runs you can’t open: $1.50');
    expect(hiddenLine({ runs: 1, calls: 0, cost: 0 })).toBe('1 run you can’t open');
    expect(hiddenLine({ runs: 0, calls: 0, cost: 0 })).toBeUndefined();
    const html = renderToStaticMarkup(createElement(DrillRuns, { runs: [run({})], hidden: { runs: 2, calls: 5, cost: 1.5 } }));
    expect(html).toContain('2 runs you can’t open: $1.50');
    expect(html).toContain('Daily digest');
    expect(html).toContain('href="/runs/exe_1?tab=spend"');
    expect(html).toContain('$0.42');
    expect(html).not.toContain('Secret project');
  });

  it('shows no sum when no call is behind the hidden runs, and an empty list in words', () => {
    const html = renderToStaticMarkup(createElement(DrillRuns, { runs: [], hidden: { runs: 3, calls: 0, cost: 0 } }));
    expect(html).toContain('3 runs you can’t open');
    expect(html).not.toContain('$');
    expect(html).toContain('No runs you can open');
  });

  it('lists calls by model and purpose with sizes, never text', () => {
    const html = renderToStaticMarkup(
      createElement(DrillCalls, { calls: [{ usageId: 'u1', at: '2026-11-03T09:30:00.000Z', provider: 'anthropic', model: 'claude-sonnet', purpose: 'judge', inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.01, priced: true, source: 'landflow', hasParts: true }], hidden: { runs: 0, calls: 1, cost: 0.2 } }),
    );
    expect(html).toContain('claude-sonnet');
    expect(html).toContain('1 call you can’t open: $0.2');
    expect(html).toContain('Judge');
  });
});

describe('momentLabel', () => {
  it('takes the date and the time from the same local moment', () => {
    const at = '2026-11-15T23:30:00.000Z';
    const d = new Date(at);
    const label = momentLabel(at);
    expect(label).toContain(d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
    expect(label).toContain(d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
    expect(momentLabel('nope')).toBe('nope');
  });

  it('names the local day, not the UTC day, in a zone far from UTC (fixed expectations)', () => {
    // 23:30 UTC on 15 November is 13:30 on 16 November in Kiritimati (UTC+14) and 15:30 on 15 November in Los Angeles.
    const label = momentLabel('2026-11-15T23:30:00.000Z');
    // The day number and the hour, whatever the browser's language (this machine's locale may not be English).
    if (process.env.TZ === 'Pacific/Kiritimati') {
      expect(label).toMatch(/\b16\b/);
      expect(label).not.toMatch(/\b15\b/);
      expect(label).toMatch(/\b(13|1):30\b/);
    }
    if (process.env.TZ === 'America/Los_Angeles') {
      expect(label).toMatch(/\b15\b/);
      expect(label).not.toMatch(/\b16\b/);
      expect(label).toMatch(/\b(15|3):30\b/);
    }
  });
});
