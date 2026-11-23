/**
 * The parts one call's prompt was made of, in tokens, and their hashes (wave 11, SP03). Never text: sizes, token
 * counts and hashes only (constitution note 17). Plain types and constants only: no imports, no zod.
 *
 * Contract file: owned by SP03, copied byte for byte by SP01 and SP02 (backbone/contracts/s11/README.md). Waves 12
 * (SP05, SP07, SP21, SP22) read it from main.
 */

/**
 * In prompt order. `formatting` is what the provider added around the parts (role markers, chat template, the tool-use
 * preamble): the reported input minus what was counted, never spread over the other parts. It is never negative; when
 * the counted parts add up to more than the reported input, `formatting` is 0 and the parts are scaled down to the
 * reported input (a call's parts always sum to its `inputTokens`).
 */
export const PROMPT_PARTS = [
  'instructions',
  'projectBlock',
  'practices',
  'memory',
  'toolNote',
  'toolDefinitions',
  'history',
  'toolResults',
  'knowledge',
  'userMessage',
  'images',
  'formatting',
] as const;
export type PromptPart = (typeof PROMPT_PARTS)[number];

export const PROMPT_PART_LABELS: Record<PromptPart, string> = {
  instructions: 'Instructions',
  projectBlock: 'Where this work fits',
  practices: 'Practices',
  memory: 'Memory',
  toolNote: 'Tool notes',
  toolDefinitions: 'Tool definitions',
  history: 'Conversation so far',
  toolResults: 'Tool results',
  knowledge: 'Knowledge',
  userMessage: 'The message',
  images: 'Images',
  formatting: 'Formatting',
};

/**
 * How the numbers were reached.
 * - `provider`: the provider's own count (Anthropic's count endpoint), wave 12.
 * - `tokenizer`: the model's own tokenizer run locally (OpenAI's BPE, an Ollama model's vocabulary), wave 12.
 * - `estimate`: characters ÷ 4 per part, scaled so the parts sum to the reported input. Wave 11 writes only this.
 * A call carries one method: the weakest used for any of its parts.
 */
export type CountMethod = 'provider' | 'tokenizer' | 'estimate';

/** Where the split was made: Landflow building the prompt, or the LLM gateway's callback (wave 12, SP21). */
export type PartsSource = 'landflow' | 'gateway';

/** One call's split, as stored in `ai_call_parts` and as the routes answer it. Parts with 0 tokens are left out. */
export interface CallParts {
  /** `ai_usage.id`; absent until the row is known (a gateway split that arrived before the spend import). */
  usageId?: string;
  /** The gateway's response id (the spend log's `request_id`), for gateway splits and calls through the server's gateway. */
  gatewayRequestId?: string;
  at: string;
  source: PartsSource;
  method: CountMethod;
  /** The reported input, cached tokens included (the row's `input_tokens`). */
  inputTokens: number;
  parts: Partial<Record<PromptPart, number>>;
  /**
   * Keyed hashes (HMAC-SHA-256 under `credentials.deriveKey('ai-call-parts')`, first 16 hex): equal text → equal hash
   * within one instance; never comparable across instances, never reversible to text.
   * - `prefixHash`: of everything before the last cache breakpoint the call asked for (tools, then system, then the
   *   messages up to that point), or of tools + system when it asked for none; two calls with the same `prefixHash`
   *   could have shared a cache entry.
   * - `promptHash`: of the whole prompt; equal → the same prompt was sent again (repeated-call detection).
   * - `partHashes`: per part (not `formatting`, not `images`), so "the instructions changed between these two runs"
   *   can be told without text.
   */
  prefixHash?: string;
  promptHash?: string;
  partHashes?: Partial<Record<PromptPart, string>>;
  /** Tool names only (never arguments or results), for the unused-tools detector (wave 14). */
  toolNames?: string[];
}
