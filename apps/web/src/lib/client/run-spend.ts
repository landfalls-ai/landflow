'use client';
/**
 * The run's Spend section on the client (wave 12, SP06): `useRunSpend` reads `GET /api/executions/:id/spend` (again every
 * 10 seconds while the run is live) and the pure helpers turn a `RunSpend` into the rows, the cache sentence, the
 * composition bar and the call rows the Spend tab draws. Numbers and names only; the answer holds no prompt text.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { CALL_PURPOSE_LABELS } from '../shared/ai-call';
import { PROMPT_PART_LABELS, type CountMethod, type PromptPart } from '../shared/ai-call-parts';
import { formatCost, formatTokens } from '../shared/ai-usage';
import { type CacheLine, type RunSpend, type SpendCall, type SpendComposition, type SpendSlice, type SpendTotals } from '../shared/run-spend';

export const SPEND_REFRESH_MS = 10_000;

export interface RunSpendState {
  spend?: RunSpend;
  loading: boolean;
  error?: string;
}

/** The run's spend, kept current while the run is live. */
export function useRunSpend(executionId: string | undefined, live = false): RunSpendState {
  const [state, setState] = useState<RunSpendState>({ loading: Boolean(executionId) });
  const read = useCallback(async () => {
    if (!executionId) return;
    try {
      const spend = await api<RunSpend>(`/api/executions/${executionId}/spend`, { background: true });
      setState({ spend, loading: false });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: (e as Error).message }));
    }
  }, [executionId]);
  useEffect(() => {
    setState({ loading: Boolean(executionId) });
    void read();
  }, [executionId, read]);
  useEffect(() => {
    if (!executionId || !live) return;
    const timer = setInterval(() => void read(), SPEND_REFRESH_MS);
    return () => clearInterval(timer);
  }, [executionId, live, read]);
  return state;
}

export type SpendBy = 'purpose' | 'model' | 'node' | 'agent' | 'step';
export const SPEND_BY_LABELS: Record<SpendBy, string> = { purpose: 'Purpose', model: 'Model', node: 'Node', agent: 'Agent', step: 'Step' };

export interface SpendRow {
  key: string;
  label: string;
  calls: number;
  /** "12.3k in · 1,450 out" */
  tokens: string;
  cached: string;
  cost: string;
  /** Percent of the run's cost (of its tokens when nothing cost anything), whole numbers. */
  share: number;
  unpriced: boolean;
}

const slicesOf = (spend: RunSpend, by: SpendBy): SpendSlice[] =>
  by === 'purpose' ? spend.byPurpose : by === 'model' ? spend.byModel : by === 'node' ? spend.byNode : by === 'agent' ? spend.byAgent : spend.byIteration;

/** What an unpriced row shows where a cost would be. */
export const UNPRICED = 'No price';

export const costOf = (t: Pick<SpendTotals, 'cost' | 'calls' | 'unpricedCalls'>): string => (t.calls > 0 && t.unpricedCalls === t.calls ? UNPRICED : formatCost(t.cost));

/** One row per slice of the chosen breakdown, as the table shows it. A step's label is "Step 2". */
export function spendRows(spend: RunSpend, by: SpendBy): SpendRow[] {
  return slicesOf(spend, by).map((s) => ({
    key: s.key,
    label: by === 'step' ? `Step ${s.key}` : s.label,
    calls: s.calls,
    tokens: `${formatTokens(s.inputTokens)} in · ${formatTokens(s.outputTokens)} out`,
    cached: s.cacheReadTokens ? formatTokens(s.cacheReadTokens) : '',
    cost: costOf(s),
    share: Math.round(s.share * 100),
    unpriced: s.calls > 0 && s.unpricedCalls === s.calls,
  }));
}

export const MISS_REASON_WORDS: Record<CacheLine['missReasons'][number], string> = {
  'instructions-changed': 'the instructions changed',
  'tools-changed': 'the tools changed',
  'below-minimum': 'the prompt may be under the provider’s minimum for caching',
  expired: 'the cache expired (more than 5 minutes apart)',
  'not-requested': 'the model asked for no cache',
  unknown: 'the reason is not known',
};

/** "53% of the prompt came from the cache · saved $0.04 · 0 misses", or why there is nothing to say. */
export function cacheSentence(cache: CacheLine): { line: string; reasons: string[] } {
  if (cache.hitRate === undefined) return { line: 'No call of this run reported cache numbers.', reasons: [] };
  const pct = Math.round(cache.hitRate * 100);
  const saved = cache.savedUsd > 0 ? ` · saved ${formatCost(cache.savedUsd)}` : '';
  const misses = ` · ${cache.missCalls} ${cache.missCalls === 1 ? 'miss' : 'misses'}`;
  const reasons = [...new Set(cache.missReasons)].map((r) => MISS_REASON_WORDS[r]);
  return { line: `${pct}% of the prompt came from the cache${saved}${misses}`, reasons };
}

export const COUNT_METHOD_LABELS: Record<CountMethod, string> = {
  provider: 'Counted exactly',
  tokenizer: 'Counted by the model’s tokenizer',
  estimate: 'Estimated',
};

export interface CompositionBar {
  method: CountMethod;
  methodLabel: string;
  total: number;
  segments: Array<{ part: PromptPart; label: string; tokens: number; tokensText: string; share: number }>;
  /** Set when some calls have no split. */
  note?: string;
}

/** The prompt's parts as one stacked bar: largest first, shares of the parts' sum (0 to 1). */
export function compositionBars(composition: SpendComposition | undefined): CompositionBar | undefined {
  if (!composition) return undefined;
  const entries = (Object.entries(composition.parts) as Array<[PromptPart, number]>).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((n, [, t]) => n + t, 0);
  const missing = composition.calls - composition.callsWithParts;
  return {
    method: composition.method,
    methodLabel: COUNT_METHOD_LABELS[composition.method],
    total,
    segments: entries.map(([part, tokens]) => ({ part, label: PROMPT_PART_LABELS[part], tokens, tokensText: formatTokens(tokens), share: total ? tokens / total : 0 })),
    ...(missing > 0 && { note: `${composition.callsWithParts} of ${composition.calls} calls have a split. No split: the call was built outside Landflow.` }),
  };
}

export interface SpendCallRow {
  usageId: string;
  at: string;
  purpose: string;
  model: string;
  tokens: string;
  cost: string;
  spanId?: string;
}

export function callRows(calls: SpendCall[]): SpendCallRow[] {
  return calls.map((c) => ({
    usageId: c.usageId,
    at: c.at,
    purpose: c.purpose ? CALL_PURPOSE_LABELS[c.purpose] : 'Not set',
    model: c.model,
    tokens: `${formatTokens(c.inputTokens)} in · ${formatTokens(c.outputTokens)} out`,
    cost: c.priced ? formatCost(c.cost) : UNPRICED,
    ...(c.spanId && { spanId: c.spanId }),
  }));
}

/** The run's headline tiles. */
export function totalTiles(t: SpendTotals): Array<[label: string, value: string]> {
  const tiles: Array<[string, string]> = [
    ['Cost', t.calls > 0 && t.unpricedCalls === t.calls ? UNPRICED : formatCost(t.cost)],
    ['Tokens in', formatTokens(t.inputTokens)],
    ['Tokens out', formatTokens(t.outputTokens)],
    ['Cached', formatTokens(t.cacheReadTokens)],
    ['Calls', String(t.calls)],
  ];
  return tiles;
}
