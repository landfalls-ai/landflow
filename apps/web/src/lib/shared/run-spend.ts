/**
 * One run's spend and one call's view (wave 12, SP05): what `GET /api/executions/:id/spend` and `GET /api/ai-calls/:id`
 * answer, and what the Run Trace's Spend section (SP06) and a call's composition (SP07) draw. Numbers, names and
 * hashes only: never prompt text (constitution note 17). Plain types and helpers: imports only the two wave-11 shared
 * files, no zod (a browser module builds no zod object).
 *
 * Contract file: owned by SP05 (`apps/web/src/lib/shared/run-spend.ts`), copied byte for byte by SP06 and SP07
 * (backbone/contracts/s12/README.md). Written against main bce6f85c + wave 11's contracts; re-checked against main 9e8239e2.
 */
import type { CallPurpose } from './ai-call';
import type { CountMethod, PartsSource, PromptPart } from './ai-call-parts';

export interface SpendTotals {
  /** The whole prompt, cached tokens included. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  calls: number;
  /** Calls of a model with no price (a local model nobody priced): their tokens count, their cost is 0. */
  unpricedCalls: number;
}

/** One row of a breakdown: by purpose, model, node, agent or iteration. */
export interface SpendSlice extends SpendTotals {
  key: string;
  label: string;
  /** Share of the run's cost (of its tokens when nothing cost anything), 0 to 1. */
  share: number;
}

/** One model call, as a row of the run's list and the head of its own view. */
export interface SpendCall {
  usageId: string;
  at: string;
  provider: string;
  model: string;
  purpose?: CallPurpose;
  iteration?: number;
  nodeId?: string;
  agentId?: string;
  sessionId?: string;
  /** Opens the call's `gen_ai.*` span in the Run Trace when set. */
  spanId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  priced: boolean;
  durationMs?: number;
  stopReason?: string;
  /** `landflow` (Landflow's meter) or `litellm` (imported from the gateway: kagent, Claude Code on kagent). */
  source: 'landflow' | 'litellm';
  /** A split exists (`GET /api/ai-calls/:id` answers `parts`). */
  hasParts: boolean;
}

/** The run's prompt, part by part, summed over the calls that have a split. */
export interface SpendComposition {
  /** The weakest method among the calls summed. */
  method: CountMethod;
  parts: Partial<Record<PromptPart, number>>;
  /** Calls summed / calls in the run (the rest have no split: "No split: the call was built outside Landflow"). */
  callsWithParts: number;
  calls: number;
}

/** How well the provider's prompt cache worked, over chat calls of providers that report it. */
export interface CacheLine {
  /** cacheRead / input over the calls counted, 0 to 1; undefined when no call reports cache numbers. */
  hitRate?: number;
  readTokens: number;
  writeTokens: number;
  /** Calls after the first of the run whose cached prefix was written again instead of read (a miss). */
  missCalls: number;
  /** Why misses happened, when it can be told from hashes: the instructions or tools changed, the prefix is under the provider's minimum, the cache expired (more than 5 minutes apart), or the model asks for no cache. */
  missReasons: Array<'instructions-changed' | 'tools-changed' | 'below-minimum' | 'expired' | 'not-requested' | 'unknown'>;
  /** What the cache saved against the same tokens at the input price; 0 when unpriced. */
  savedUsd: number;
}

export interface RunSpend {
  executionId: string;
  /** This run and every sub-run the viewer may open; sub-runs they may not open are in `hidden`. */
  totals: SpendTotals;
  byPurpose: SpendSlice[];
  byModel: SpendSlice[];
  byNode: SpendSlice[];
  byAgent: SpendSlice[];
  /** Agent loop steps (Landflow agents and the AI Agent node both record them), one slice per iteration, key = the number. */
  byIteration: SpendSlice[];
  composition?: SpendComposition;
  cache: CacheLine;
  /** Newest last; at most 500 (then `truncated`). */
  calls: SpendCall[];
  truncated: boolean;
  /** Sub-runs (sub-workflows, team members' sessions) the viewer can't open: counted, never listed. */
  hidden: { runs: number; totals: SpendTotals };
}

/** One call's view (`GET /api/ai-calls/:id`). */
export interface AiCallView {
  call: SpendCall;
  /** The split, when one exists; `source` says who made it (Landflow, or the gateway for kagent calls). */
  parts?: { source: PartsSource; method: CountMethod; parts: Partial<Record<PromptPart, number>>; toolNames?: string[] };
  /** Against the previous call of the same session or run (same agent, same model): what changed, by hash. */
  previous?: { usageId: string; samePrefix: boolean; changedParts: PromptPart[] };
  /** Where to go: the run (when there is one the viewer may open) and the span. */
  runHref?: string;
}

export const emptySpendTotals = (): SpendTotals => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, calls: 0, unpricedCalls: 0 });

/** Uncached input: the part of the prompt neither read from nor written to the cache. */
export const uncachedInput = (t: Pick<SpendTotals, 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): number =>
  Math.max(0, t.inputTokens - t.cacheReadTokens - t.cacheWriteTokens);
