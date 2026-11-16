'use client';
/**
 * One model call in the Run Trace sheet (wave 12, SP07): match a model span to the ledger's call, read the call's view,
 * and turn its split into the legend the sheet draws. The helpers are pure (tested in test/call-spend-ui.test.ts).
 * Numbers, names and hashes only; never prompt text (constitution note 17).
 */
import { useEffect, useState } from 'react';
import { PROMPT_PART_LABELS, type CountMethod, type PromptPart } from '../shared/ai-call-parts';
import { uncachedInput, type AiCallView, type RunSpend, type SpendCall } from '../shared/run-spend';
import { api } from './api';

/** What `matchSpanToCall` reads of a Run Trace span (a `RunSpan` fits). */
export interface SpanForMatch {
  name: string;
  startedAt: string;
  endedAt?: string;
  caller?: { id: string };
  actor?: { id: string };
  usage?: { model?: string };
  nodeId?: string;
  status?: string;
}

const BEFORE_MS = 1000;
const AFTER_MS = 2000;

/** The agent a span belongs to, when its actor or the one that asked is a Landflow agent (`agent:<id>`). */
const agentOf = (span: SpanForMatch): string | undefined => {
  for (const id of [span.actor?.id, span.caller?.id]) if (id?.startsWith('agent:')) return id.slice('agent:'.length);
  return undefined;
};

/**
 * The call of the run's list that a model span is: the same model name, `at` within `[startedAt - 1 s, endedAt + 2 s]`,
 * the same agent when the span has one; on a tie the call nearest the span's end. None: undefined.
 */
export function matchSpanToCall(span: SpanForMatch, calls: SpendCall[]): SpendCall | undefined {
  const start = Date.parse(span.startedAt);
  const end = span.endedAt ? Date.parse(span.endedAt) : start;
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  const model = span.usage?.model ?? span.name;
  const agent = agentOf(span);
  let best: SpendCall | undefined;
  let bestGap = Infinity;
  for (const call of calls) {
    if (call.model !== model && call.model !== span.name) continue;
    if (agent && call.agentId && call.agentId !== agent) continue;
    if (span.nodeId && call.nodeId && call.nodeId !== span.nodeId) continue;
    const at = Date.parse(call.at);
    if (Number.isNaN(at) || at < start - BEFORE_MS || at > end + AFTER_MS) continue;
    const gap = Math.abs(at - end);
    if (gap < bestGap) {
      best = call;
      bestGap = gap;
    }
  }
  return best;
}

/** Parts in the order of the prompt's cache layout: the cached prefix first (cache-layout.md), then the rest. */
const CACHED_PREFIX: PromptPart[] = ['toolDefinitions', 'instructions', 'projectBlock', 'practices'];
const REST: PromptPart[] = ['memory', 'toolNote', 'history', 'toolResults', 'knowledge', 'userMessage', 'images', 'formatting'];

export interface LegendItem {
  part: PromptPart;
  label: string;
  tokens: number;
  /** 0 to 1 of the call's parts. */
  share: number;
  /** In the prefix the cache holds (tools, instructions, project block, practices). */
  cachedPrefix: boolean;
}

export interface CompositionLegend {
  items: LegendItem[];
  total: number;
  /** "Counted by the provider", "Counted with the model's own tokenizer", "Estimated from text length". */
  method: string;
  /** "From the LLM gateway" for a gateway split. */
  origin?: string;
  /** The cached prefix is marked only when the call used the cache. */
  cacheUsed: boolean;
}

export const METHOD_WORDS: Record<CountMethod, string> = {
  provider: "Counted by the provider's own count",
  tokenizer: "Counted with the model's own tokenizer",
  estimate: 'Estimated from text length (about 4 characters a token), scaled to the tokens the provider reported',
};

/** The split of a call as a legend: one item per part with tokens, biggest share visible at a glance. Undefined without a split. */
export function compositionLegend(view: Pick<AiCallView, 'call' | 'parts'>): CompositionLegend | undefined {
  const split = view.parts;
  if (!split) return undefined;
  const total = Object.values(split.parts).reduce<number>((sum, n) => sum + (n ?? 0), 0);
  if (!total) return undefined;
  const cacheUsed = view.call.cacheReadTokens > 0 || view.call.cacheWriteTokens > 0;
  const items: LegendItem[] = [...CACHED_PREFIX, ...REST]
    .filter((part) => (split.parts[part] ?? 0) > 0)
    .map((part) => ({
      part,
      label: PROMPT_PART_LABELS[part],
      tokens: split.parts[part] ?? 0,
      share: (split.parts[part] ?? 0) / total,
      cachedPrefix: cacheUsed && CACHED_PREFIX.includes(part),
    }));
  return { items, total, method: METHOD_WORDS[split.method], ...(split.source === 'gateway' && { origin: 'From the LLM gateway' }), cacheUsed };
}

const n = (value: number): string => value.toLocaleString('en-US');

/** "8,000 read from the cache · 2,000 not cached · written: 0". */
export function cacheLine(call: Pick<SpendCall, 'provider' | 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): string {
  if (!call.cacheReadTokens && !call.cacheWriteTokens && !['anthropic', 'openai'].includes(call.provider)) return 'This model reports no cache numbers.';
  return `${n(call.cacheReadTokens)} read from the cache · ${n(uncachedInput(call))} not cached · written: ${n(call.cacheWriteTokens)}`;
}

const CHANGED_WORDS: Partial<Record<PromptPart, string>> = {
  instructions: 'The instructions changed',
  toolDefinitions: 'The tool definitions changed',
  projectBlock: 'The project block changed',
  practices: 'The practices changed',
  memory: 'The memory changed',
  toolNote: 'The tool notes changed',
};

/** What changed against the previous call: "Same prefix as the previous call", or what differs. Undefined without a previous call. */
export function previousLine(previous: AiCallView['previous']): string | undefined {
  if (!previous) return undefined;
  if (previous.samePrefix) return 'Same prefix as the previous call';
  const words = previous.changedParts.map((part) => CHANGED_WORDS[part]).filter((w): w is string => Boolean(w));
  return words.length ? [...new Set(words)].join(' · ') : 'The prefix changed since the previous call';
}

/**
 * Why a call has no split. The retention days are a server setting the client does not know, so the words stay neutral
 * about them. `truncated`: the run's list holds only its newest 500 calls, so a missing call may just be older.
 */
export function noSplitReason(call: Pick<SpendCall, 'source'> | undefined, truncated = false): string {
  if (!call) return truncated ? "This step may be older than the 500 newest calls the run's spend record holds." : "This step isn't in the run's spend record yet.";
  if (call.source === 'litellm') return 'The call was built outside Landflow and the gateway sent no split.';
  return 'No split was kept for it: a split is made for chat calls Landflow builds, and kept for a limited time.';
}

export type CallSpendState = 'loading' | 'error' | 'nosplit' | 'view';

/** Which branch the sheet draws: a failed request is an error, never a statement about the call. */
export function callSpendState(s: { callsLoading: boolean; callsError?: string; call?: unknown; viewLoading: boolean; viewError?: string; hasView: boolean }): CallSpendState {
  if (s.callsLoading || (s.call && s.viewLoading)) return 'loading';
  if (s.callsError || (s.call && s.viewError)) return 'error';
  return s.call && s.hasView ? 'view' : 'nosplit';
}

interface Loaded<T> {
  data?: T;
  loading: boolean;
  error?: string;
}

/** One call's view (`GET /api/ai-calls/:id`); nothing is read while `usageId` is undefined. */
export function useAiCall(usageId: string | undefined): Loaded<AiCallView> {
  const [state, setState] = useState<Loaded<AiCallView> & { id?: string }>({ loading: Boolean(usageId) });
  useEffect(() => {
    if (!usageId) return;
    let alive = true;
    api<AiCallView>(`/api/ai-calls/${encodeURIComponent(usageId)}`, { background: true })
      .then((data) => alive && setState({ id: usageId, data, loading: false }))
      .catch((e: Error) => alive && setState({ id: usageId, loading: false, error: e.message }));
    return () => {
      alive = false;
    };
  }, [usageId]);
  return usageId && state.id === usageId ? state : { loading: Boolean(usageId) };
}

/** The run's calls (`GET /api/executions/:id/spend`), for matching a span to its call; `refresh` reads them again. */
export function useRunCalls(executionId: string | undefined, refresh?: string): Loaded<RunSpend> {
  const [state, setState] = useState<Loaded<RunSpend> & { id?: string }>({ loading: Boolean(executionId) });
  useEffect(() => {
    if (!executionId) return;
    let alive = true;
    api<RunSpend>(`/api/executions/${encodeURIComponent(executionId)}/spend`, { background: true })
      .then((spend) => alive && setState({ id: executionId, data: spend, loading: false }))
      .catch((e: Error) => alive && setState({ id: executionId, loading: false, error: e.message }));
    return () => {
      alive = false;
    };
  }, [executionId, refresh]);
  return executionId && state.id === executionId ? state : { loading: Boolean(executionId) };
}
