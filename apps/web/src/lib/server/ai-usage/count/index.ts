/**
 * Exact token counts per part of a Landflow call's prompt (wave 12, SP22): the provider's own count endpoint for
 * Anthropic, OpenAI's encodings offline, the model's own vocabulary for Ollama. `countParts` returns what it could
 * count and which method that was; anything it cannot count (another provider, a gateway, an unknown tokenizer, a
 * failed or over-budget count request) is `undefined`, and the caller falls back to the estimate. It never throws and
 * never keeps or logs prompt text.
 */
import type { PromptPart, CountMethod } from '../../../shared/ai-call-parts';
import { envWithAliases, ollamaUrl } from '../../config';
import type { Database } from '../../db';
import { logger } from '../../telemetry/logger';
import type { PromptDraft } from '../call-context';
import { anthropicCounter } from './anthropic';
import { openAiCounter } from './openai';
import { ollamaTokenizer } from './vocab-cache';

/** What a counter needs to know about the call. */
export interface CountCall {
  usageId: string;
  provider: string;
  model: string;
  agentId?: string;
  /** The handle in force when the call was queued: the `ai_usage` row is read through it. */
  db: Database;
  /** The key the count cache hashes requests with (never the text itself). */
  key: Buffer;
}

/** Tokens of each segment of a draft (same order), or undefined when this counter cannot count the call. */
export interface Counter {
  method: Exclude<CountMethod, 'estimate'>;
  count(call: CountCall, draft: PromptDraft): Promise<number[] | undefined>;
}

export interface CountedParts {
  method: Exclude<CountMethod, 'estimate'>;
  /** Tokens counted per part, `formatting` and `images` left out (the caller works out `formatting` as what is left). */
  parts: Partial<Record<PromptPart, number>>;
}

/** `LANDFLOW_AI_PARTS_COUNT=estimate` turns counting off. */
export const countingOn = (): boolean => (envWithAliases('LANDFLOW_AI_PARTS_COUNT') ?? 'exact').trim().toLowerCase() !== 'estimate';

/** The Ollama a call went to: its agent's own server, else OLLAMA_URL. */
async function ollamaBase(agentId: string | undefined): Promise<string> {
  if (agentId) {
    try {
      const { agentStore } = await import('../../agents/store');
      const own = agentStore.get(agentId)?.model?.baseUrl?.trim();
      if (own) return own.replace(/\/v1\/?$/, '');
    } catch {
      // fall through to the default server
    }
  }
  return ollamaUrl();
}

const ollamaCounter: Counter = {
  method: 'tokenizer',
  async count(call, draft) {
    const loaded = await ollamaTokenizer(await ollamaBase(call.agentId), call.model);
    if (!loaded || !('bpe' in loaded)) return undefined;
    return draft.segments.map((s) => loaded.bpe.count(s.text));
  },
};

const COUNTERS: Record<string, Counter> = { anthropic: anthropicCounter, openai: openAiCounter, ollama: ollamaCounter };

export async function countParts(draft: PromptDraft, call: CountCall): Promise<CountedParts | undefined> {
  if (!countingOn()) return undefined;
  const counter = COUNTERS[call.provider];
  if (!counter) return undefined;
  try {
    const perSegment = await counter.count(call, draft);
    if (!perSegment || perSegment.length !== draft.segments.length) return undefined;
    const parts: Partial<Record<PromptPart, number>> = {};
    draft.segments.forEach((segment, i) => {
      const tokens = Math.max(0, Math.round(perSegment[i] ?? 0));
      if (!tokens) return;
      // A `formatting` segment (the run's date stamp) is counted but belongs to `formatting`, which the caller works out
      // as the reported input minus every other part, so it is never part of the instructions.
      if (segment.part !== 'formatting') parts[segment.part] = (parts[segment.part] ?? 0) + tokens;
    });
    return { method: counter.method, parts };
  } catch (error) {
    // A count that failed is an estimate; the call it describes is long over. The message is the provider's, never the prompt.
    logger.info('could not count the parts of a model call exactly', { provider: call.provider, error: (error as Error).message });
    return undefined;
  }
}
