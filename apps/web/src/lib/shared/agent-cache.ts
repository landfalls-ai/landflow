/**
 * The exact-match response cache of a standalone agent (docs/agents.md "Response cache"): a question asked again, word for word,
 * gets the stored answer with no model call. Only runs whose answer depends on nothing but the question and the agent's config
 * are cached, so a hit is never stale for a reason Landflow can see. A semantic cache (similar questions) is not built.
 */

export const CACHE_TTL_DEFAULT = 3_600;
export const CACHE_TTL_MIN = 10;
export const CACHE_TTL_MAX = 30 * 86_400;

export interface AgentCache {
  /** Answer a repeated question from the stored answer. */
  enabled: boolean;
  /** How long an answer is kept, in seconds. */
  ttlSeconds: number;
}

export const DEFAULT_CACHE: AgentCache = { enabled: false, ttlSeconds: CACHE_TTL_DEFAULT };

/** A complete cache setting from partial input; `undefined` when it is off at the default TTL (nothing to keep). */
export function cleanCache(input: Partial<AgentCache> | undefined): AgentCache | undefined {
  if (!input?.enabled) return undefined;
  const ttl = Math.round(Number(input.ttlSeconds) || CACHE_TTL_DEFAULT);
  return { enabled: true, ttlSeconds: Math.min(CACHE_TTL_MAX, Math.max(CACHE_TTL_MIN, ttl)) };
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
