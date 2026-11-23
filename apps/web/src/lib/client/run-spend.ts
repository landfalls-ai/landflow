'use client';
/**
 * The run's Spend section on the client (wave 12, SP06): `useRunSpend` reads `GET /api/executions/:id/spend` (again
 * every 10 seconds while the run is live; the Spend tab and the call sheet share one read and one poll per run) and the
 * pure helpers turn a `RunSpend` into the rows, the cache sentence, the composition bar and the call rows the Spend tab
 * draws. Numbers and names only; the answer holds no prompt text.
 */
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { api } from './api';
import { CALL_PURPOSE_LABELS } from '../shared/ai-call';
import { PROMPT_PART_LABELS, type CountMethod, type PromptPart } from '../shared/ai-call-parts';
import { formatCost, formatTokens } from '../shared/ai-usage';
import type { RunModel } from '../shared/run-trace-model';
import { matchSpansToCalls } from './span-call-match';
import { type CacheLine, type RunSpend, type SpendCall, type SpendComposition, type SpendSlice, type SpendTotals } from '../shared/run-spend';

export const SPEND_REFRESH_MS = 10_000;

export interface RunSpendState {
  spend?: RunSpend;
  loading: boolean;
  error?: string;
}

/** Whether the run's spend must be read once more: the run was live and is not any more (the last calls land after the last poll). */
export const readsAtEnd = (wasLive: boolean, live: boolean): boolean => wasLive && !live;

interface SpendEntry {
  state: RunSpendState;
  /** When the last answer arrived (ms). */
  at: number;
  /** Whether the run was live when the latest read was asked: a finished run must not keep a mid-run answer. */
  live: boolean;
  /** The read in flight, shared by everyone who asks meanwhile. */
  reading?: Promise<void>;
  /** A read was asked while one was in flight: read once more when it lands (its answer may predate the ask). */
  again?: { live: boolean };
  /** Who watches the run as live (the Spend tab, an open sheet): one poll for all of them. */
  holders: Map<symbol, boolean>;
  timer?: ReturnType<typeof setInterval>;
  listeners: Set<() => void>;
}

/** One entry per run: the Spend tab and every opened call sheet read the same answer, and a read in flight is shared. */
const entries = new Map<string, SpendEntry>();
const MAX_ENTRIES = 6;

function entryFor(executionId: string): SpendEntry {
  let entry = entries.get(executionId);
  if (!entry) {
    entry = { state: { loading: true }, at: 0, live: false, holders: new Map(), listeners: new Set() };
    entries.set(executionId, entry);
    // Keep the newest few runs; one nobody listens to is dropped first.
    for (const [id, old] of entries) {
      if (entries.size <= MAX_ENTRIES) break;
      if (id !== executionId && old.listeners.size === 0) {
        if (old.timer) clearInterval(old.timer);
        entries.delete(id);
      }
    }
  }
  return entry;
}

const publish = (entry: SpendEntry, state: RunSpendState) => {
  entry.state = state;
  for (const listener of entry.listeners) listener();
};

/**
 * Reads the run's spend. A read asked while another is in flight shares it and is followed by one more when it lands,
 * so an end-of-run or span-ended read is never lost to a poll that started before it. `live` says whether the run is
 * live as the asker sees it; it is kept with the answer.
 */
export function readSpend(executionId: string, live = false): Promise<void> {
  const entry = entryFor(executionId);
  entry.live = live;
  if (entry.reading) {
    entry.again = { live };
    return entry.reading;
  }
  entry.reading = (async () => {
    try {
      const spend = await api<RunSpend>(`/api/executions/${executionId}/spend`, { background: true });
      entry.at = Date.now();
      publish(entry, { spend, loading: false });
    } catch (e) {
      publish(entry, { ...entry.state, loading: false, error: (e as Error).message });
    } finally {
      entry.reading = undefined;
    }
    const next = entry.again;
    entry.again = undefined;
    if (next) await readSpend(executionId, next.live);
  })();
  return entry.reading;
}

/**
 * Reads unless the answer is good enough: there is one, it is not a live run's answer for a run that has ended, and for
 * a live run it is younger than a poll. A read in flight is shared; one that began while the run was live is followed by
 * another when the run has ended meanwhile.
 */
export function ensureRunSpend(executionId: string, live = false): Promise<void> {
  const entry = entryFor(executionId);
  const stale = entry.live && !live;
  if (entry.reading) return stale ? readSpend(executionId, live) : entry.reading;
  if (entry.state.spend && !stale && !(live && Date.now() - entry.at > SPEND_REFRESH_MS)) return Promise.resolve();
  return readSpend(executionId, live);
}

/** What is known of a run's spend right now, and a way to hear of changes. */
export const runSpendState = (executionId: string): RunSpendState => entryFor(executionId).state;
export function watchRunSpend(executionId: string, listener: () => void): () => void {
  const entry = entryFor(executionId);
  entry.listeners.add(listener);
  return () => void entry.listeners.delete(listener);
}

/** Says whether this watcher sees the run as live; while any does, the run is read every 10 s, once for all of them. */
export function holdRunLive(executionId: string, live: boolean): () => void {
  const entry = entryFor(executionId);
  const token = Symbol('holder');
  const sync = () => {
    const any = [...entry.holders.values()].some(Boolean);
    if (any && !entry.timer) entry.timer = setInterval(() => void (entry.reading ? undefined : readSpend(executionId, true)), SPEND_REFRESH_MS);
    if (!any && entry.timer) {
      clearInterval(entry.timer);
      entry.timer = undefined;
    }
  };
  entry.holders.set(token, live);
  sync();
  return () => {
    entry.holders.delete(token);
    sync();
  };
}

/** Forgets what was read (a test starts from nothing). */
export const resetRunSpend = () => {
  for (const entry of entries.values()) if (entry.timer) clearInterval(entry.timer);
  entries.clear();
};

/**
 * The run's spend, kept current while the run is live. Every caller of one run shares one answer, one read and one poll:
 * the call sheet passes a `refresh` key (the span's end and status) to read again when a live span moves. When the run
 * has ended the answer is read once more, also by a tab or sheet opened after the end. `retry` reads again.
 */
export function useRunSpend(executionId: string | undefined, live = false, refresh?: string): RunSpendState & { retry: () => void } {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const wasLive = useRef(false);
  const liveNow = useRef(live);
  liveNow.current = live;
  const lastRefresh = useRef(refresh);
  useEffect(() => {
    if (!executionId) return;
    const unwatch = watchRunSpend(executionId, rerender);
    // Nothing read yet, a live run's answer older than a poll, or a mid-run answer of a run that has ended.
    void ensureRunSpend(executionId, liveNow.current);
    return unwatch;
  }, [executionId]);
  useEffect(() => {
    if (!executionId || lastRefresh.current === refresh) return;
    lastRefresh.current = refresh;
    void readSpend(executionId, liveNow.current);
  }, [executionId, refresh]);
  useEffect(() => {
    if (!executionId) return;
    if (readsAtEnd(wasLive.current, live)) void ensureRunSpend(executionId, false);
    wasLive.current = live;
    return holdRunLive(executionId, live);
  }, [executionId, live]);
  const retry = useCallback(() => {
    if (!executionId) return;
    const entry = entryFor(executionId);
    publish(entry, { ...entry.state, loading: !entry.state.spend, error: undefined });
    void readSpend(executionId, liveNow.current);
  }, [executionId]);
  const state: RunSpendState = executionId ? runSpendState(executionId) : { loading: false };
  return { ...state, retry };
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
  const slices = slicesOf(spend, by);
  const ordered = by === 'step' ? [...slices].sort((a, b) => Number(a.key) - Number(b.key)) : slices;
  return ordered.map((s) => ({
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
  const counts = new Map<CacheLine['missReasons'][number], number>();
  for (const r of cache.missReasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  const reasons = [...counts].map(([r, n]) => (n > 1 ? `${MISS_REASON_WORDS[r]} (${n} calls)` : MISS_REASON_WORDS[r]));
  return { line: `${pct}% of the prompt came from the cache${saved}${misses}`, reasons };
}

export const COUNT_METHOD_LABELS: Record<CountMethod, string> = {
  provider: 'Counted by the provider',
  tokenizer: 'Counted with the model’s own tokenizer',
  estimate: 'Estimated from text length',
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
    ...(missing > 0 && { note: `${composition.callsWithParts} of ${composition.calls} chat calls have a split. The others have none: they were built outside Landflow, a part could not be told, or the split was kept only for a limited time. Open a call to see which.` }),
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

/** One row per call; a call that is one of the run's model spans (the shared rule of `span-call-match.ts`) carries its span id. */
export function callRows(calls: SpendCall[], model?: Pick<RunModel, 'spans'>): SpendCallRow[] {
  const spanOf = new Map<string, string>();
  if (model) for (const [spanId, call] of matchSpansToCalls(Object.values(model.spans), calls)) spanOf.set(call.usageId, spanId);
  return calls.map((c) => {
    const spanId = spanOf.get(c.usageId);
    return {
      usageId: c.usageId,
      at: c.at,
      purpose: c.purpose ? CALL_PURPOSE_LABELS[c.purpose] : 'Not set',
      model: c.model,
      tokens: `${formatTokens(c.inputTokens)} in · ${formatTokens(c.outputTokens)} out`,
      cost: c.priced ? formatCost(c.cost) : UNPRICED,
      ...(spanId && { spanId }),
    };
  });
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
