'use client';
/**
 * One model call in the Run Trace sheet (wave 12, SP07): match a model span to the ledger's call, read the call's view,
 * and turn its split into the legend the sheet draws. The helpers are pure (tested in test/call-spend-ui.test.ts).
 * Numbers, names and hashes only; never prompt text (constitution note 17).
 */
import { useEffect, useState } from 'react';
import { PROMPT_PART_LABELS, type PromptPart } from '../shared/ai-call-parts';
import { uncachedInput, type AiCallView, type SpendCall } from '../shared/run-spend';
import { api } from './api';
import { COUNT_METHOD_LABELS } from './run-spend';
import { matchSpansToCalls, type MatchSpan } from './span-call-match';

/** What `matchSpanToCall` reads of a Run Trace span (a `RunSpan` fits). `status` only refreshes the run's calls. */
export type SpanForMatch = MatchSpan & { status?: string };

/**
 * The call a model span is, by the rule the Spend tab uses too (`span-call-match.ts`: model, node, agent and time,
 * one to one). `siblings` are the run's other model spans: they take their own calls first, so two spans never claim
 * one call. None: undefined.
 */
export function matchSpanToCall(span: MatchSpan, calls: readonly SpendCall[], siblings: Iterable<MatchSpan> = []): SpendCall | undefined {
  const all = new Map<string, MatchSpan>();
  for (const s of siblings) all.set(s.id, s);
  all.set(span.id, span);
  return matchSpansToCalls(all.values(), calls).get(span.id);
}

/**
 * Parts in the order of the prompt's cache layout: the stable prefix first (cache-layout.md), then the rest. The stable
 * prefix is what a cache point always follows (tools, instructions, project block, practices). Since SP19 the
 * conversation's last block is a cache point too, so the earlier conversation (history, tool results) is read from the
 * cache when the call used it: those parts are `maybeCached`, never drawn as not cached.
 */
const CACHED_PREFIX: PromptPart[] = ['toolDefinitions', 'instructions', 'projectBlock', 'practices'];
const CONVERSATION: PromptPart[] = ['history', 'toolResults'];
const REST: PromptPart[] = ['memory', 'toolNote', 'history', 'toolResults', 'knowledge', 'userMessage', 'images', 'formatting'];

export interface LegendItem {
  part: PromptPart;
  label: string;
  tokens: number;
  /** 0 to 1 of the call's parts. */
  share: number;
  /** In the stable prefix, the one the cache holds first (tools, instructions, project block, practices). */
  cachedPrefix: boolean;
  /** The conversation so far: its last block is a cache point too, so the cache read may cover it. */
  maybeCached: boolean;
}

export interface CompositionLegend {
  items: LegendItem[];
  total: number;
  /** The words of `COUNT_METHOD_LABELS`, the same as the Spend tab's. */
  method: string;
  /** "From the LLM gateway" for a gateway split. */
  origin?: string;
  /** The stable prefix and the conversation are marked only when the call used the cache. */
  cacheUsed: boolean;
}

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
      maybeCached: cacheUsed && CONVERSATION.includes(part),
    }));
  return { items, total, method: COUNT_METHOD_LABELS[split.method], ...(split.source === 'gateway' && { origin: 'From the LLM gateway' }), cacheUsed };
}

const n = (value: number): string => value.toLocaleString('en-US');

/**
 * The provider family of a call's `provider`: a gateway row can spell it with a LiteLLM prefix or a route name
 * (`anthropic/claude-…`, `openai.chat`), and `litellm` says nothing about the model behind it.
 */
const providerFamily = (provider: string): string => provider.toLowerCase().split(/[/.:_]/)[0] ?? '';

/** Whether the provider reports cache numbers at all: Anthropic and OpenAI do; a gateway row's provider is not known. */
const reportsCache = (provider: string): boolean => ['anthropic', 'openai', 'litellm'].includes(providerFamily(provider));

/** "8,000 read from the cache · 2,000 not cached · written: 0". */
export function cacheLine(call: Pick<SpendCall, 'provider' | 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): string {
  if (!call.cacheReadTokens && !call.cacheWriteTokens && !reportsCache(call.provider)) return 'This model reports no cache numbers.';
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
