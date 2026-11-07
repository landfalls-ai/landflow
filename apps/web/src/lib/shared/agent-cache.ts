/**
 * The exact-match response cache of a standalone agent (docs/agents.md "Response cache"): a question asked again, word for word,
 * gets the stored answer with no model call. Only runs whose answer depends on nothing but the question and the agent's config
 * are cached, so a hit is never stale for a reason Landflow can see. The optional semantic cache also answers a question that
 * means the same as a stored one (embedding similarity at or above a threshold).
 */

export const CACHE_TTL_DEFAULT = 3_600;
export const CACHE_TTL_MIN = 10;
export const CACHE_TTL_MAX = 30 * 86_400;

export interface AgentCache {
  /** Answer a repeated question from the stored answer. */
  enabled: boolean;
  /** How long an answer is kept, in seconds. */
  ttlSeconds: number;
  /** Also answer a question that means the same as a stored one. */
  semantic?: SemanticCache;
}

export const SEMANTIC_THRESHOLD_DEFAULT = 0.92;
export const SEMANTIC_THRESHOLD_MIN = 0.7;
export const SEMANTIC_THRESHOLD_MAX = 0.99;
export const SEMANTIC_MODEL_DEFAULT = 'nomic-embed-text';

export interface SemanticCache {
  enabled: boolean;
  /** Cosine similarity a stored question needs to answer a new one (0.7 to 0.99). */
  threshold: number;
  /** An Ollama embedding model (any server that speaks Ollama's /api/embed). */
  model: string;
  /** The Ollama server; empty uses OLLAMA_URL. */
  baseUrl?: string;
}

export const DEFAULT_SEMANTIC: SemanticCache = { enabled: false, threshold: SEMANTIC_THRESHOLD_DEFAULT, model: SEMANTIC_MODEL_DEFAULT };

/** A complete semantic setting from partial input; `undefined` when it is off. */
export function cleanSemantic(input: Partial<SemanticCache> | undefined): SemanticCache | undefined {
  if (!input?.enabled) return undefined;
  const threshold = Number(input.threshold) || SEMANTIC_THRESHOLD_DEFAULT;
  const baseUrl = input.baseUrl?.trim();
  return {
    enabled: true,
    threshold: Math.min(SEMANTIC_THRESHOLD_MAX, Math.max(SEMANTIC_THRESHOLD_MIN, threshold)),
    model: input.model?.trim() || SEMANTIC_MODEL_DEFAULT,
    ...(baseUrl && { baseUrl }),
  };
}

/** How alike two vectors are, from -1 to 1 (1 is the same direction). */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export const DEFAULT_CACHE: AgentCache = { enabled: false, ttlSeconds: CACHE_TTL_DEFAULT };

/** A complete cache setting from partial input; `undefined` when it is off at the default TTL (nothing to keep). */
export function cleanCache(input: Partial<AgentCache> | undefined): AgentCache | undefined {
  if (!input?.enabled) return undefined;
  const ttl = Math.round(Number(input.ttlSeconds) || CACHE_TTL_DEFAULT);
  const semantic = cleanSemantic(input.semantic);
  return { enabled: true, ttlSeconds: Math.min(CACHE_TTL_MAX, Math.max(CACHE_TTL_MIN, ttl)), ...(semantic && { semantic }) };
}

/** What makes two questions "the same": the words, ignoring case and runs of whitespace. */
export const normalizeQuestion = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase();

export interface CacheContext {
  cache: AgentCache | undefined;
  /** Messages in the session once the user's new message is in: 1 means this is the first turn. */
  messageCount: number;
  toolCount: number;
  /** Cross-session memory is on: the answer may depend on notes about the person. */
  memory: boolean;
  /** A workflow brought its own model or tools, or a team run is driving the agent. */
  borrowed: boolean;
}

/** Why a run can't use the cache, or `undefined` when it can. */
export function uncacheable(context: CacheContext): string | undefined {
  if (!context.cache?.enabled) return 'the response cache is off';
  if (context.messageCount !== 1) return 'it is not the first message of the session';
  if (context.toolCount > 0) return 'the agent has tools, so the answer may depend on live data';
  if (context.memory) return 'cross-session memory is on';
  if (context.borrowed) return 'a workflow or team supplies its own model or tools';
  return undefined;
}
