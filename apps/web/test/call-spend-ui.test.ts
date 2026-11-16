/** A call's composition and cache line in the Run Trace sheet (SP07): the matching, the legend and the words. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { cacheLine, callSpendState, compositionLegend, matchSpanToCall, noSplitReason, previousLine } from '../src/lib/client/call-spend';
import { COUNT_METHOD_LABELS, callRows } from '../src/lib/client/run-spend';
import { CallSpendView, shadesFor } from '../src/components/run-trace/call-spend';
import type { AiCallView, SpendCall } from '../src/lib/shared/run-spend';

const call = (over: Partial<SpendCall> = {}): SpendCall => ({
  usageId: 'u1', at: '2026-11-16T10:00:05.000Z', provider: 'anthropic', model: 'claude-sonnet-4-6', agentId: 'a1',
  inputTokens: 10_000, outputTokens: 500, cacheReadTokens: 8000, cacheWriteTokens: 0, cost: 0.01, priced: true, source: 'landflow', hasParts: true, ...over,
});
const span = { id: 's1', name: 'claude-sonnet-4-6', startedAt: '2026-11-16T10:00:02.000Z', endedAt: '2026-11-16T10:00:05.000Z', caller: { id: 'agent:a1' } };

describe('matchSpanToCall', () => {
  it('matches the call inside the window, 1 s before and 2 s after', () => {
    expect(matchSpanToCall(span, [call()])?.usageId).toBe('u1');
    expect(matchSpanToCall(span, [call({ at: '2026-11-16T10:00:07.000Z' })])?.usageId).toBe('u1');
    expect(matchSpanToCall(span, [call({ at: '2026-11-16T10:00:07.500Z' })])).toBeUndefined();
    expect(matchSpanToCall(span, [call({ at: '2026-11-16T10:00:00.500Z' })])).toBeUndefined();
  });
  it('takes the nearest on a tie', () => {
    const calls = [call({ usageId: 'far', at: '2026-11-16T10:00:03.000Z' }), call({ usageId: 'near', at: '2026-11-16T10:00:05.200Z' })];
    expect(matchSpanToCall(span, calls)?.usageId).toBe('near');
  });
  it('ignores another agent or another model', () => {
    expect(matchSpanToCall(span, [call({ agentId: 'a2' })])).toBeUndefined();
    expect(matchSpanToCall(span, [call({ model: 'gpt-5' })])).toBeUndefined();
  });
  it('finds nothing in an empty list', () => expect(matchSpanToCall(span, [])).toBeUndefined());
  it('is one to one: a call goes to the span it is nearest to, and a span takes one call', () => {
    const first = { ...span, id: 's1', startedAt: '2026-11-16T10:00:00.000Z', endedAt: '2026-11-16T10:00:04.000Z' };
    const second = { ...span, id: 's2', startedAt: '2026-11-16T10:00:04.300Z', endedAt: '2026-11-16T10:00:08.000Z' };
    const calls = [call({ usageId: 'c1', at: '2026-11-16T10:00:04.010Z' }), call({ usageId: 'c2', at: '2026-11-16T10:00:08.010Z' })];
    expect(matchSpanToCall(first, calls, [first, second])?.usageId).toBe('c1');
    expect(matchSpanToCall(second, calls, [first, second])?.usageId).toBe('c2');
    // One call only: the nearer span has it, the other has none (it is not shown twice).
    const one = [call({ usageId: 'c1', at: '2026-11-16T10:00:04.100Z' })];
    expect(matchSpanToCall(first, one, [first, second])?.usageId).toBe('c1');
    expect(matchSpanToCall(second, one, [first, second])).toBeUndefined();
  });
  it('treats an open span as ending at its start', () => {
    const open = { ...span, endedAt: undefined };
    expect(matchSpanToCall(open, [call({ at: '2026-11-16T10:00:03.900Z' })])?.usageId).toBe('u1');
    expect(matchSpanToCall(open, [call({ at: '2026-11-16T10:00:04.100Z' })])).toBeUndefined();
  });
  it('agrees with the Spend tab: the row that opens a span is the call the sheet shows for it', () => {
    const spans = [
      { ...span, id: 'a', kind: 'model', startedAt: '2026-11-16T10:00:00.000Z', endedAt: '2026-11-16T10:00:04.000Z' },
      { ...span, id: 'b', kind: 'model', startedAt: '2026-11-16T10:00:04.300Z', endedAt: '2026-11-16T10:00:08.000Z' },
    ];
    const calls = [call({ usageId: 'c1', at: '2026-11-16T10:00:04.010Z' }), call({ usageId: 'c2', at: '2026-11-16T10:00:08.010Z' }), call({ usageId: 'c3', at: '2026-11-16T10:00:04.200Z' })];
    const rows = callRows(calls, { spans: Object.fromEntries(spans.map((s) => [s.id, s])) } as never);
    for (const s of spans) {
      const opens = rows.find((r) => r.spanId === s.id);
      expect(opens?.usageId).toBe(matchSpanToCall(s, calls, spans)?.usageId);
    }
    expect(rows.filter((r) => r.spanId)).toHaveLength(2);
  });
});

const view = (over: Partial<AiCallView> = {}): AiCallView => ({
  call: call(),
  parts: { source: 'landflow', method: 'estimate', parts: { toolDefinitions: 1000, instructions: 3000, memory: 500, history: 5000, userMessage: 500 } },
  previous: { usageId: 'u0', samePrefix: true, changedParts: [] },
  ...over,
});

describe('compositionLegend', () => {
  it('lists parts with tokens and share, the cached prefix first and marked', () => {
    const legend = compositionLegend(view())!;
    expect(legend.items.map((i) => i.part)).toEqual(['toolDefinitions', 'instructions', 'memory', 'history', 'userMessage']);
    expect(legend.items.filter((i) => i.cachedPrefix).map((i) => i.part)).toEqual(['toolDefinitions', 'instructions']);
    expect(legend.items[1].share).toBeCloseTo(0.3);
    expect(legend.method).toBe('Estimated from text length');
  });
  it('words each method', () => {
    // The one set, the same words as the Spend tab's.
    for (const [method, word] of [['provider', 'Counted by the provider'], ['tokenizer', 'Counted with the model’s own tokenizer'], ['estimate', 'Estimated from text length']] as const) {
      expect(compositionLegend(view({ parts: { source: 'landflow', method, parts: { history: 10 } } }))!.method).toBe(word);
      expect(COUNT_METHOD_LABELS[method]).toBe(word);
    }
  });
  it('says so for a gateway split', () => {
    const legend = compositionLegend(view({ parts: { source: 'gateway', method: 'estimate', parts: { history: 10 } } }))!;
    expect(legend.origin).toBe('From the LLM gateway');
  });
  it('marks no prefix when the cache was not used, and has no legend without a split', () => {
    const legend = compositionLegend(view({ call: call({ cacheReadTokens: 0, cacheWriteTokens: 0 }) }))!;
    expect(legend.items.some((i) => i.cachedPrefix)).toBe(false);
    expect(compositionLegend({ call: call() })).toBeUndefined();
  });
});

describe('the words', () => {
  it('the cache line', () => {
    expect(cacheLine(call({ cacheReadTokens: 8000, inputTokens: 10_000 }))).toBe('8,000 read from the cache · 2,000 not cached · written: 0');
    expect(cacheLine(call({ provider: 'ollama', cacheReadTokens: 0 }))).toBe('This model reports no cache numbers.');
    // A gateway row's provider can carry a LiteLLM prefix or be `litellm` itself: decided by family, never "no cache numbers".
    for (const provider of ['anthropic/claude-sonnet-4-6', 'openai/gpt-5', 'anthropic.messages', 'litellm', 'Anthropic']) {
      expect(cacheLine(call({ provider, cacheReadTokens: 0, cacheWriteTokens: 0 })), provider).toBe('0 read from the cache · 10,000 not cached · written: 0');
    }
    expect(cacheLine(call({ provider: 'ollama_chat', cacheReadTokens: 0, cacheWriteTokens: 0 }))).toBe('This model reports no cache numbers.');
  });
  it('what changed', () => {
    expect(previousLine({ usageId: 'u0', samePrefix: true, changedParts: [] })).toBe('Same prefix as the previous call');
    expect(previousLine({ usageId: 'u0', samePrefix: false, changedParts: ['instructions', 'history'] })).toBe('The instructions changed');
    expect(previousLine({ usageId: 'u0', samePrefix: false, changedParts: [] })).toBe('The prefix changed since the previous call');
    expect(previousLine(undefined)).toBeUndefined();
  });
  it('why there is no split', () => {
    expect(noSplitReason(call())).toContain('No split was kept');
    expect(noSplitReason(call({ source: 'litellm' }))).toContain('gateway sent no split');
    expect(noSplitReason(undefined)).toContain("isn't in the run's spend record");
    expect(noSplitReason(undefined, true)).toContain('500 newest');
  });
  it('a failed request is an error, not a fact about the call', () => {
    const base = { callsLoading: false, viewLoading: false, hasView: false };
    expect(callSpendState({ ...base, callsError: 'boom' })).toBe('error');
    expect(callSpendState({ ...base, call: {}, viewError: '404' })).toBe('error');
    expect(callSpendState({ ...base })).toBe('nosplit');
    expect(callSpendState({ ...base, call: {} })).toBe('nosplit');
    expect(callSpendState({ ...base, call: {}, hasView: true })).toBe('view');
    expect(callSpendState({ ...base, callsLoading: true })).toBe('loading');
  });
  it('matches by node when both have one', () => {
    expect(matchSpanToCall({ ...span, nodeId: 'n1' }, [call({ nodeId: 'n2' })])).toBeUndefined();
    expect(matchSpanToCall({ ...span, nodeId: 'n1' }, [call({ nodeId: 'n1' })])?.usageId).toBe('u1');
  });
});

describe('the rendered view', () => {
  it('shows sizes and words, no prompt text', () => {
    const html = renderToStaticMarkup(createElement(CallSpendView, { view: view() }));
    expect(html).toContain('8,000 read from the cache');
    expect(html).toContain('Same prefix as the previous call');
    expect(html).toContain('stable prefix');
    expect(html).not.toContain('cached prefix');
    expect(html).toContain('may be cached');
    expect(html).not.toMatch(/toolNames|hash/i);
    const legend = compositionLegend(view())!;
    expect(legend.items.reduce((sum, i) => sum + i.share, 0)).toBeCloseTo(1);
  });
  it('shades the prefix in the accent and the rest in neutral', () => {
    const items = compositionLegend(view())!.items;
    const shades = shadesFor(items);
    items.forEach((item, i) => expect(shades[i].startsWith('bg-ac')).toBe(item.cachedPrefix || item.maybeCached));
    // The conversation may be read from the cache (its last block is a cache point): never drawn as plain neutral.
    expect(items.find((i) => i.part === 'history')?.maybeCached).toBe(true);
    expect(shades[2]).toMatch(/^bg-t3/);
    const none = compositionLegend(view({ call: call({ cacheReadTokens: 0, cacheWriteTokens: 0 }) }))!;
    expect(shadesFor(none.items).some((x) => x.startsWith('bg-ac'))).toBe(false);
    expect(none.items.some((i) => i.maybeCached)).toBe(false);
  });
  it('shows the Memory and Conversation rows in neutral shades', () => {
    const html = renderToStaticMarkup(createElement(CallSpendView, { view: view() }));
    expect(html).toContain('bg-t3');
  });
  it('says no split with the reason', () => {
    const html = renderToStaticMarkup(createElement(CallSpendView, { view: { call: call({ source: 'litellm' }) } }));
    expect(html).toContain('No split for this call.');
    expect(html).toContain('built outside Landflow');
  });
});
