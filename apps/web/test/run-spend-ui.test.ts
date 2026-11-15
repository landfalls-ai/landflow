/**
 * The run's Spend tab (wave 12, SP06): the pure helpers on SP05's demo numbers (an agent of three iterations on a priced
 * Claude model, one guardrail call on an unpriced local model), the tab's visibility and a static render that holds no
 * prompt text and says how each part was counted. Made-up numbers.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { JournalEvent, RunActor } from '@/lib/shared/run-trace';
import { foldJournal } from '@/lib/shared/run-trace-model';
import type { RunSpend, SpendCall, SpendSlice, SpendTotals } from '@/lib/shared/run-spend';
import { cacheSentence, callRows, compositionBars, matchCallToSpan, readsAtEnd, spendRows, totalTiles } from '../src/lib/client/run-spend';
import { TAB_LABELS, visibleTabs } from '../src/components/run-trace/run-trace-tabs';
import { SpendBody } from '../src/components/run-trace/spend';

const totals = (o: Partial<SpendTotals>): SpendTotals => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, calls: 0, unpricedCalls: 0, ...o });
const slice = (key: string, label: string, share: number, o: Partial<SpendTotals>): SpendSlice => ({ key, label, share, ...totals(o) });

const answer = { inputTokens: 30000, outputTokens: 1450, cacheReadTokens: 16000, cacheWriteTokens: 8000, cost: 0.07455, calls: 3 };
const guard = { inputTokens: 600, outputTokens: 50, calls: 1, unpricedCalls: 1 };
const call = (n: number, o: Partial<SpendCall>): SpendCall => ({
  usageId: `u${n}`, at: `2026-11-16T10:00:0${n}.000Z`, provider: 'anthropic', model: 'claude-sonnet-4-6', purpose: 'answer', iteration: n, nodeId: 'agent1', agentId: 'ag1',
  inputTokens: 10000, outputTokens: 480, cacheReadTokens: n === 1 ? 0 : 8000, cacheWriteTokens: n === 1 ? 8000 : 0, cost: 0.0248, priced: true, source: 'landflow', hasParts: true, spanId: `span${n}`, ...o,
});

const demo: RunSpend = {
  executionId: 'ex_demo',
  totals: totals({ inputTokens: 30600, outputTokens: 1500, cacheReadTokens: 16000, cacheWriteTokens: 8000, cost: 0.07455, calls: 4, unpricedCalls: 1 }),
  byPurpose: [slice('answer', 'Answer', 1, answer), slice('guardrail', 'Guardrail check', 0, guard)],
  byModel: [slice('anthropic/claude-sonnet-4-6', 'claude-sonnet-4-6', 1, answer), slice('ollama/llama3.2', 'llama3.2', 0, guard)],
  byNode: [slice('agent1', 'Research agent', 1, answer)],
  byAgent: [slice('ag1', 'Researcher', 1, answer)],
  byIteration: [slice('1', '1', 0.4, { inputTokens: 10000, outputTokens: 500, cost: 0.03, calls: 1 }), slice('2', '2', 0.3, { inputTokens: 10000, outputTokens: 500, cost: 0.02, calls: 1 })],
  composition: { method: 'estimate', parts: { instructions: 4000, toolDefinitions: 3000, history: 2000, userMessage: 1000 }, callsWithParts: 3, calls: 4 },
  cache: { hitRate: 0.5333, readTokens: 16000, writeTokens: 8000, missCalls: 0, missReasons: [], savedUsd: 0.0432 },
  calls: [call(1, {}), call(2, {}), call(3, {}), call(4, { provider: 'ollama', model: 'llama3.2', purpose: 'guardrail', priced: false, cost: 0, inputTokens: 600, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, hasParts: false, spanId: undefined })],
  truncated: false,
  hidden: { runs: 2, totals: totals({ cost: 0.5, calls: 2 }) },
};

describe('the Spend helpers', () => {
  it('rows by purpose, model and step', () => {
    expect(spendRows(demo, 'purpose').map((r) => [r.label, r.cost, r.share, r.cached])).toEqual([
      ['Answer', '$0.0746', 100, '16k'],
      ['Guardrail check', 'No price', 0, ''],
    ]);
    expect(spendRows(demo, 'model')[1]).toMatchObject({ label: 'llama3.2', unpriced: true, tokens: '600 in · 50 out' });
    expect(spendRows(demo, 'step').map((r) => r.label)).toEqual(['Step 1', 'Step 2']);
  });

  it('the cache line in words, with misses and their reasons', () => {
    expect(cacheSentence(demo.cache)).toEqual({ line: '53% of the prompt came from the cache · saved $0.0432 · 0 misses', reasons: [] });
    const missed = cacheSentence({ ...demo.cache, missCalls: 2, missReasons: ['expired', 'tools-changed', 'expired'] });
    expect(missed.line).toContain('2 misses');
    expect(missed.reasons).toEqual(['the cache expired (more than 5 minutes apart) (2 calls)', 'the tools changed']);
    expect(cacheSentence({ readTokens: 0, writeTokens: 0, missCalls: 0, missReasons: [], savedUsd: 0 }).line).toMatch(/No call/);
  });

  it('the composition bar: largest first, shares sum to 1, the method in words, the calls without a split', () => {
    const bar = compositionBars(demo.composition)!;
    expect(bar.segments.map((s) => s.label)).toEqual(['Instructions', 'Tool definitions', 'Conversation so far', 'The message']);
    expect(bar.segments.reduce((n, s) => n + s.share, 0)).toBeCloseTo(1);
    expect(bar.methodLabel).toBe('Estimated');
    expect(bar.note).toMatch(/3 of 4 calls/);
    expect(compositionBars({ ...demo.composition!, method: 'provider', callsWithParts: 4 })).toMatchObject({ methodLabel: 'Counted exactly' });
    expect(compositionBars({ ...demo.composition!, method: 'tokenizer' })!.methodLabel).toBe('Counted by the model’s tokenizer');
    expect(compositionBars(undefined)).toBeUndefined();
  });

  it('the call rows and the totals', () => {
    const rows = callRows(demo.calls);
    expect(rows[0]).toMatchObject({ purpose: 'Answer', cost: '$0.0248' });
    expect(rows[0].spanId).toBeUndefined(); // the call's OpenTelemetry id opens nothing: only a matched journal span does
    expect(rows[3]).toMatchObject({ purpose: 'Guardrail check', cost: 'No price' });
    expect(totalTiles(demo.totals)).toEqual([['Cost', '$0.0746'], ['Tokens in', '30.6k'], ['Tokens out', '1,500'], ['Cached', '16k'], ['Calls', '4']]);
  });
});

describe('the Spend refresh and the span of a call', () => {
  it('reads once more when a live run ends, not otherwise', () => {
    expect(readsAtEnd(true, false)).toBe(true);
    expect(readsAtEnd(false, false)).toBe(false);
    expect(readsAtEnd(true, true)).toBe(false);
    expect(readsAtEnd(false, true)).toBe(false);
  });

  it('steps read in step order whatever the route sent', () => {
    const odd = { ...demo, byIteration: [slice('3', '3', 0.5, { calls: 1 }), slice('1', '1', 0.3, { calls: 1 }), slice('2', '2', 0.2, { calls: 1 })] };
    expect(spendRows(odd, 'step').map((r) => r.label)).toEqual(['Step 1', 'Step 2', 'Step 3']);
  });

  const agent: RunActor = { id: 'agent:ag1', type: 'agent', name: 'Researcher' };
  const journal = foldJournal(
    (
      [
        { type: 'span.started', spanId: 'run', kind: 'run', name: 'Flow', actor: { id: 'workflow', type: 'system', name: 'Flow' } },
        { type: 'span.started', spanId: 'run/model:0', parentSpanId: 'run', kind: 'model', name: 'claude-sonnet-4-6', actor: { id: 'model:claude-sonnet-4-6', type: 'model', name: 'claude-sonnet-4-6' }, caller: agent },
        { type: 'span.ended', spanId: 'run/model:0', status: 'success' },
        { type: 'span.started', spanId: 'run/model:1', parentSpanId: 'run', kind: 'model', name: 'claude-sonnet-4-6', actor: { id: 'model:claude-sonnet-4-6', type: 'model', name: 'claude-sonnet-4-6' }, caller: agent },
        { type: 'span.ended', spanId: 'run/model:1', status: 'success' },
        { type: 'span.ended', spanId: 'run', status: 'success' },
      ] as Array<Record<string, unknown>>
    ).map((e, i) => ({ seq: i + 1, executionId: 'x1', at: new Date(Date.parse('2026-11-16T10:00:00Z') + i * 1000).toISOString(), ...e }) as JournalEvent),
  );

  it('finds the journal span of a call that carries an OpenTelemetry span id', () => {
    const c = (at: string, o: Partial<SpendCall> = {}) => call(1, { spanId: '5b8aa5a2d2c5f1e0', model: 'claude-sonnet-4-6', agentId: 'ag1', at, ...o });
    expect(matchCallToSpan(c('2026-11-16T10:00:01.200Z'), journal)).toBe('run/model:0');
    expect(matchCallToSpan(c('2026-11-16T10:00:03.100Z'), journal)).toBe('run/model:1');
    expect(matchCallToSpan(c('2026-11-16T10:00:01.200Z', { model: 'other' }), journal)).toBeUndefined();
    expect(matchCallToSpan(c('2026-11-16T10:00:01.200Z', { agentId: 'ag2' }), journal)).toBeUndefined();
    expect(matchCallToSpan(c('2026-11-16T11:00:00.000Z'), journal)).toBeUndefined();
    const rows = callRows([c('2026-11-16T10:00:01.200Z'), c('2026-11-16T11:00:00.000Z', { usageId: 'late' })], journal);
    expect(rows.map((r) => r.spanId)).toEqual(['run/model:0', undefined]);
  });

  it('draws a time as a button only when a span was found', () => {
    const html = renderToStaticMarkup(createElement(SpendBody, { spend: { ...demo, calls: [call(1, { at: '2026-11-16T10:00:01.200Z', model: 'claude-sonnet-4-6' }), call(2, { at: '2026-11-16T12:00:00.000Z', model: 'claude-sonnet-4-6' })] }, open: () => {}, model: journal }));
    expect(html.match(/aria-label="Open the call at/g)).toHaveLength(1);
  });
});

describe('the Spend tab', () => {
  const actor: RunActor = { id: 'workflow', type: 'system', name: 'Flow' };
  const run = (usage?: Record<string, number>) =>
    foldJournal(
      (
        [
          { type: 'span.started', spanId: 'run', kind: 'run', name: 'Flow', actor },
          { type: 'span.started', spanId: 'm1', parentSpanId: 'run', kind: 'model', name: 'claude', actor: { id: 'model:c', type: 'model', name: 'claude' } },
          { type: 'span.ended', spanId: 'm1', status: 'success', ...(usage && { usage }) },
          { type: 'span.ended', spanId: 'run', status: 'success' },
        ] as Array<Record<string, unknown>>
      ).map((e, i) => ({ seq: i + 1, executionId: 'x1', at: new Date(Date.parse('2026-11-16T10:00:00Z') + i * 1000).toISOString(), ...e }) as JournalEvent),
    );

  it('shows only for a run with model tokens', () => {
    expect(visibleTabs(run({ inputTokens: 10, outputTokens: 5 }))).toContain('spend');
    expect(visibleTabs(run())).not.toContain('spend');
    expect(TAB_LABELS.spend).toBe('Spend');
  });

  it('renders the totals, every view, the method and the hidden runs, with no prompt text', () => {
    const html = renderToStaticMarkup(createElement(SpendBody, { spend: demo, open: () => {} }));
    for (const text of ['0.0746', '53% of the prompt came from the cache', 'Estimated', 'Instructions', 'Guardrail check', '2 runs you can’t open: $0.5', '1 unpriced call', 'Where it went', 'Step']) expect(html).toContain(text);
    expect(html).not.toMatch(/prompt text|system prompt|You are/);
    expect(html).not.toContain('/settings#ai-prices'); // no viewer here: only admins get the link
  });
});
