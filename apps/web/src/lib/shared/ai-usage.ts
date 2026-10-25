/**
 * AI usage and cost (docs/observability.md → Token & cost tracking): what every model call used, what it
 * cost by the price table, and the caps that stop a run. Types shared by the API routes and the React
 * client. No runtime imports.
 */

/** Tokens, estimated cost (USD) and number of model calls. */
export interface AiUsageTotals {
  inputTokens: number;
  outputTokens: number;
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
