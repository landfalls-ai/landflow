/** What `GET /api/insights/ai/cache` answers (SP11): the AI page's cache card. Counts, hit rates and reasons only, never prompt text. */
import type { AiSpendPeriod } from './ai-spend';
import type { CacheLine } from './run-spend';

export interface AiCacheAgent {
  /** An agent id, `none` (calls with no agent) or `shared` ("Another agent"). */
  key: string;
  label: string;
  /** Input tokens that were not cached (input minus cache reads and writes, as the Run Trace's call sheet says), over the calls the cache line counts. */
  uncachedTokens: number;
  calls: number;
  hitRate?: number;
  missCalls: number;
  /** Distinct runs (a session, else an execution; a call with neither is no run) the cache line counts, and how many had at least one miss. */
  runs: number;
  missRuns: number;
  missReasons: CacheLine['missReasons'];
}

export interface AiCacheReport {
  period: AiSpendPeriod;
  /** The cache line over the period: the calls `cacheLine` counts (Anthropic and OpenAI rows, and gateway rows that report cache tokens). */
  cache: CacheLine;
  /** Distinct runs counted over the period, and how many had a miss. */
  runs: number;
  missRuns: number;
  /** The top 5 by uncached input. */
  agents: AiCacheAgent[];
  /** Anthropic calls of the AI Agent node, which asks for no cache (docs/limitations.md): in this period. */
  agentNode: { calls: number; uncachedTokens: number };
  /** Miss reasons come from prompt splits, which are kept 30 days: set when the period reaches further back. */
  reasonsPartial: boolean;
  /** More calls than one answer holds: the newest are counted. */
  truncated: boolean;
}
