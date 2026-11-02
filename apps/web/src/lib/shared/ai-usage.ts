/**
 * AI usage and cost (docs/observability.md → Token & cost tracking): what every model call used, what it
 * cost by the price table, and the caps that stop a run. Types shared by the API routes and the React
 * client. No runtime imports.
 */

/** Tokens, estimated cost (USD) and number of model calls. */
export interface AiUsageTotals {
  /** The whole prompt, cached tokens included. */
  inputTokens: number;
  outputTokens: number;
  /** Parts of `inputTokens` read from the provider's cache (Anthropic cache reads, OpenAI cached input), priced lower. Absent = none. */
  cacheReadTokens?: number;
  /** Parts of `inputTokens` written to Anthropic's cache, priced higher than plain input. */
  cacheWriteTokens?: number;
  /** Estimated from the price table, in US dollars. */
  cost: number;
  calls: number;
}

/** Totals of one provider/model. */
export interface AiModelUsage extends AiUsageTotals {
  provider: string;
  model: string;
}

/** Kept on an execution record: the model calls of this execution (sub-executions keep their own). */
export interface ExecutionAiUsage extends AiUsageTotals {
  models: AiModelUsage[];
}

/** USD per million tokens. Ollama and other local models cost nothing unless you price them. */
export interface ModelPrice {
  provider: string;
  /** A model id, or a prefix of one: `claude-sonnet-4-6` also prices `claude-sonnet-4-6-20260101`. */
  model: string;
  input: number;
  output: number;
  /** USD per million cached input tokens read (Anthropic cache reads, OpenAI cached input). Absent = the input price. */
  cacheRead?: number;
  /** USD per million tokens written to Anthropic's cache. Absent = the input price. */
  cacheWrite?: number;
  /** A request whose prompt is over `above` tokens is priced at these instead, all of it (Haiku 5.5: $0.50 / $2.50 over 100K). */
  longContext?: { above: number; input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

/** GET /api/ai-usage/prices: the built-in defaults and the instance's overrides (Settings → AI prices). */
export interface PriceTable {
  defaults: ModelPrice[];
  overrides: ModelPrice[];
}

/** GET /api/ai-usage: totals for a workflow, an agent or an execution over a period. */
export interface AiUsageReport {
  totals: AiUsageTotals;
  models: AiModelUsage[];
  /** One entry per day with usage, oldest first (instance time zone). */
  days: Array<{ day: string } & AiUsageTotals>;
  /** Only when grouped: per workflow (Insights) or per agent. */
  workflows?: Array<{ workflowId: string } & AiUsageTotals>;
  agents?: Array<{ agentId: string } & AiUsageTotals>;
  /** Today's usage against the caps that apply (workflow or agent reports). */
  today?: AiUsageTotals;
  month?: AiUsageTotals;
}

/** A cap's limits, per day and per month, in tokens or US dollars (0 or absent = none). */
export interface UsageCapSet {
  /** The credential's or user's name when the cap was saved, for the error a refused call shows. */
  name?: string;
  dayTokens?: number;
  dayCost?: number;
  monthTokens?: number;
  monthCost?: number;
}

/** Settings → AI usage caps: caps per model credential and per user (who started the run). */
export interface AiCaps {
  /** By credential id. */
  credentials: Record<string, UsageCapSet>;
  /** By user id. */
  users: Record<string, UsageCapSet>;
  /** For every signed-in user without a cap of their own. */
  allUsers?: UsageCapSet;
}

/** GET /api/settings/ai-caps: the caps and what each has used in the current day and month. */
export interface AiCapsView {
  caps: AiCaps;
  usage: {
    credentials: Record<string, { day: AiUsageTotals; month: AiUsageTotals }>;
    users: Record<string, { day: AiUsageTotals; month: AiUsageTotals }>;
  };
}

export const EMPTY_USAGE: AiUsageTotals = { inputTokens: 0, outputTokens: 0, cost: 0, calls: 0 };

/** "$0.0123", "$1.20", "<$0.0001" */
export function formatCost(cost: number): string {
  if (!cost) return '$0';
  if (cost < 0.0001) return '<$0.0001';
  if (cost < 1) return `$${cost.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
  return `$${cost.toFixed(2)}`;
}

/** "1,234" / "12.3k" / "4.5M" */
export function formatTokens(tokens: number): string {
  if (tokens < 10_000) return tokens.toLocaleString('en-US');
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${(tokens / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
}

/** "12k read · 3k written", or empty when nothing was cached. */
export function formatCache(totals: Pick<AiUsageTotals, 'cacheReadTokens' | 'cacheWriteTokens'>): string {
  const parts: string[] = [];
  if (totals.cacheReadTokens) parts.push(`${formatTokens(totals.cacheReadTokens)} read`);
  if (totals.cacheWriteTokens) parts.push(`${formatTokens(totals.cacheWriteTokens)} written`);
  return parts.join(' · ');
}
