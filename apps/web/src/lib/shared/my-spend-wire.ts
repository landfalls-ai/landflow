/**
 * The wire between `GET /api/brain/my-spend` (wave 14, SP14) and the landflow-brain mod's status line (SP15): the
 * route a brain key reaches for its own AI spend, and the part of the answer the mod reads. Plain types and constants
 * only: no imports, no zod (the mod imports nothing from the web app).
 *
 * Contract file: owned by SP14 (backbone/contracts/s14/README.md). Copied byte for byte by SP14 to
 * apps/web/src/lib/shared/my-spend-wire.ts and packages/cli/src/spend/my-spend-wire.ts (packages never import apps),
 * and by SP15 to apps/web/claude-plugins/landflow-brain/hooks/my-spend-wire.ts.
 */

/**
 * The caller's own AI spend (`AiMySpend`, lib/shared/ai-spend.ts), the same function and answer as
 * `GET /api/insights/ai/me`. Reached with the `brain:read` scope (`brain:write` includes it), so the mod's key and the
 * CLI reach it; `/api/insights/**` stays `executions:read`.
 */
export const MY_SPEND_PATH = '/api/brain/my-spend';

/** The periods it takes (`?period=`, default `7d`), as `GET /api/insights/ai/me`. The status line asks `24h`. */
export const MY_SPEND_PERIODS = ['24h', '7d', '30d', '90d'] as const;
export type MySpendPeriod = (typeof MY_SPEND_PERIODS)[number];

/** One day's (or the month's) totals as the mod reads them: a subset of `AiSpendTotals`. */
export interface MySpendTotals {
  /** Dollars as recorded (a local model nobody priced adds 0). */
  cost: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  /** Calls with no price now and no cost (a local model nobody priced). */
  unpricedCalls: number;
}

/** What the mod reads of the answer: a subset of `AiMySpend`. `today` is the instance's day, as the You card's. */
export interface MySpendWire {
  today: MySpendTotals;
  month: MySpendTotals;
}
