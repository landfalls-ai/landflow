/**
 * The AI page after wave 13 (token spend): the report on the daily rollup (SP08), the runs and calls behind a number
 * (SP09), the month-end forecast (SP11) and a person's own spend and local models (SP12). More groups, a daily series,
 * the previous period, filters, 90 days and custom ranges, people per D1 (docs/llm-gateway.md, "Who sees what").
 * Numbers, names and hashes only: never prompt text (constitution note 17). Plain types and constants with type-only
 * imports of shared files, no zod (a browser module builds no zod object).
 *
 * Contract file: owned by SP08 (`apps/web/src/lib/shared/ai-spend.ts`), copied byte for byte by SP09, SP10, SP11, SP12
 * (backbone/contracts/s13/README.md). Drafted against main bce6f85c; re-checked against main b7474031 (wave 12 merged,
 * PR #60): it builds on wave 12's `SpendTotals`/`SpendCall` (lib/shared/run-spend.ts) and today's `AiConsoleReport`.
 */
import type { CallPurpose } from './ai-call';
import type { ModelPrice } from './ai-usage';
import type { AiConsoleCap, AiConsoleReport } from './llm-gateway';
import type { SpendCall, SpendTotals } from './run-spend';

export const AI_SPEND_PERIODS = ['24h', '7d', '30d', '90d', 'custom'] as const;
export type AiSpendPeriod = (typeof AI_SPEND_PERIODS)[number];

/** A custom range spans at most this many days (`LANDFLOW_AI_USAGE_RETENTION_DAYS`' default; raw rows and the rollup share it). */
export const AI_SPEND_MAX_DAYS = 400;

/** Today's six groups plus four. `person` follows D1 (every row, by name); every other group the viewer's visibility. */
export const AI_SPEND_GROUPS = ['project', 'goal', 'agent', 'workflow', 'person', 'model', 'source', 'credential', 'surface', 'purpose'] as const;
export type AiSpendGroup = (typeof AI_SPEND_GROUPS)[number];

/** Rows on a page of runs or calls; at most this many rows in one CSV answer. */
export const AI_SPEND_PAGE_SIZE = 50;
export const AI_SPEND_CSV_MAX_ROWS = 10_000;

/** A run's totals (wave 12's `SpendTotals`: tokens with cached ones, cost, calls, `unpricedCalls`) plus distinct runs. */
export interface AiSpendTotals extends SpendTotals {
  /**
   * Distinct runs (an execution, else an agent session) behind the calls (constitution note 13: count runs, not rows).
   * Counted on `ai_usage` itself, which is kept as long as the rollup; never summed from rollup rows.
   */
  runs: number;
}

export interface AiSpendRow extends AiSpendTotals {
  /** A project, goal, agent, workflow, user or credential id; `provider/model`; a source key (`landflow:landflow`, `litellm:kagent`…); a surface; a purpose; `none`, `shared` ("Another …") or `other` (the tail past 50). */
  key: string;
  label: string;
  /** A person row links to the person filter; a project, agent or workflow row the viewer can read, to its page. */
  href?: string;
  /** Share of the group's whole cost (of its tokens when nothing cost anything), 0 to 1. */
  share: number;
  /** The same key's totals in the previous period of the same length (with `compare=1`; absent for a custom range over 90 days). */
  previous?: Pick<AiSpendTotals, 'cost' | 'inputTokens' | 'outputTokens' | 'calls'>;
  /**
   * The current price table has no price for the model and its calls cost nothing: a local model nobody priced, or a
   * model the table doesn't know (run-spend.ts `callOf`'s rule). Set on `model` rows only; the AI page ranks these by
   * tokens and offers admins "Set a price" (SP12).
   */
  unpriced?: boolean;
}

/** One day (one hour for 24h) of the series. */
export interface AiSpendPoint extends Pick<AiSpendTotals, 'cost' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'calls'> {
  /** `YYYY-MM-DD` in the instance's time zone (the `day` column), or for 24h the hour's start as an ISO time. */
  at: string;
}

/** The series split by one group (`stack=<group>`): its top 5 by cost (by tokens when nothing cost anything) and "Other". */
export interface AiSpendStack {
  group: AiSpendGroup;
  rows: Array<{ key: string; label: string }>;
  /** Each point's values in the order of `rows`; `at` as in `series`. */
  points: Array<{ at: string; cost: number[]; tokens: number[] }>;
  /** `person` stacks every row of the period (D1: its whole is `peopleTotals`); every other group the rows the viewer can see (`totals`). */
  scope: 'everyone' | 'visible';
}

export interface AiSpendFilters {
  projectId?: string;
  agentId?: string;
  workflowId?: string;
  userId?: string;
  credentialId?: string;
  model?: string;
  purpose?: CallPurpose | 'none';
  /** A source key, as `AiSpendRow.key` of the source group. */
  source?: string;
  surface?: string;
}

export interface AiSpendReport {
  period: AiSpendPeriod;
  /** The range's first and last day for day periods (`YYYY-MM-DD`), ISO times for 24h. */
  from: string;
  to: string;
  filters: AiSpendFilters;
  /** What the viewer can see (visibility rule 2). */
  totals: AiSpendTotals;
  /**
   * Every row of the period (rule 1), the person group's whole. Under a filter by project, agent, workflow or credential
   * (which could name what the viewer can't read) it is the filtered rows the viewer can see; under a filter by person,
   * model, purpose, source or surface it stays every row that matches.
   */
  peopleTotals: AiSpendTotals;
  /** The previous period of the same length (with `compare=1`; absent for a custom range over 90 days). */
  previous?: AiSpendTotals;
  /** Visible rows by day (by hour for 24h); days with no calls are present with zeros. */
  series: AiSpendPoint[];
  /** With `stack=<group>`. */
  stack?: AiSpendStack;
  /** Every group, always all ten keys (the page switches groups without asking again). */
  groups: Record<AiSpendGroup, AiSpendRow[]>;
  /** Biggest rises and falls against the previous period (with `compare=1`), any group, top 5 each; never an "Another …", "Other" or "No …" row. */
  movers: Array<{ group: AiSpendGroup; key: string; label: string; cost: number; previousCost: number }>;
}

/**
 * What `GET /api/insights/ai` answers: the report plus today's caps, requests, viewer and cap-raise set-up, unchanged.
 * A JSON superset of the `AiConsoleReport` it answered before wave 13: every key it had, with the same meaning.
 */
export type AiPageReport = AiSpendReport & Pick<AiConsoleReport, 'caps' | 'requests' | 'viewer' | 'capRaise'>;

/** What a viewer can't open behind a number: counted, never listed (rule 3); no names and no ids. */
export interface AiSpendHidden {
  runs: number;
  calls: number;
  cost: number;
}

/** A run behind a group row (SP09); `runs` is 1. */
export interface AiSpendRun extends AiSpendTotals {
  executionId?: string;
  /** An agent session with no execution (a chat, a task, a schedule). */
  sessionId?: string;
  agentId?: string;
  workflowId?: string;
  /** The workflow's or agent's name. */
  label: string;
  /** The run's first call. */
  at: string;
  /** `/runs/<id>?tab=spend`, or `/agents/<agentId>?tab=sessions&session=<id>`. */
  href?: string;
}

export interface AiSpendRunsPage {
  runs: AiSpendRun[];
  hidden: AiSpendHidden;
  /** Opaque; pass it back as `cursor` until it is absent. */
  next?: string;
}

/** A call behind a group row (SP09): wave 12's `SpendCall`, plus where it ran. It opens with `GET /api/ai-calls/:id`. */
export interface AiSpendCall extends SpendCall {
  executionId?: string;
  /** Set when the viewer may open the run (as `AiCallView.runHref`). */
  runHref?: string;
}

export interface AiSpendCallsPage {
  calls: AiSpendCall[];
  hidden: AiSpendHidden;
  next?: string;
}

/** A month-end forecast (SP11, `lib/shared/ai-forecast.ts` `forecastMonth`; SP23 alerts on it). Money, or tokens for a token cap. */
export interface AiForecast {
  monthToDate: number;
  /** Month to date + the mean of the last 7 complete days × days left. */
  p50: number;
  /** p50 ∓ 1.2816 · σ₇ · √(days left); `low` never below month to date. */
  low: number;
  high: number;
  /** Fewer than 7 days of data this month: the band is shown, labelled early. */
  early: boolean;
  daysObserved: number;
  daysLeft: number;
}

/** One cap or budget with its forecast (monthly) or today's pace (daily). Only caps the viewer may see (rule 5). */
export interface AiForecastCap {
  /** The watched cap's id (`parseCapId` reads it): `user:`, `agent:`, `credential:`, `workflow:` or `project:`. */
  capId: string;
  subject: string;
  period: 'day' | 'month';
  metric: 'cost' | 'tokens';
  max: number;
  used: number;
  /** Monthly caps. */
  forecast?: AiForecast;
  /** Daily caps: used ÷ hours so far × 24. */
  pace?: number;
  /** The first day (`YYYY-MM-DD`) the P50 line reaches `max`; absent when it stays under. */
  reachesOn?: string;
}

/** `GET /api/insights/ai/forecast`. */
export interface AiForecastReport {
  /** `YYYY-MM` in the instance's time zone. */
  month: string;
  /** The month's total of what the viewer can see. */
  total: AiForecast;
  caps: AiForecastCap[];
}

/** `GET /api/insights/ai/me` (SP12; read by SP14's MCP tool and CLI and SP15's status line): the caller's own rows only. */
export interface AiMySpend {
  today: AiSpendTotals;
  month: AiSpendTotals;
  period: AiSpendPeriod;
  from: string;
  to: string;
  series: AiSpendPoint[];
  byModel: AiSpendRow[];
  byPurpose: AiSpendRow[];
  bySurface: AiSpendRow[];
  /**
   * The caller's own user caps (their own set, or everyone's default), each with the forecast card's figure for the same
   * cap: `forecast` and `reachesOn` (the first day the P50 line reaches `max`) for a monthly cap, `pace` for a daily one.
   */
  caps: Array<AiConsoleCap & { forecast?: AiForecast; pace?: number; reachesOn?: string }>;
  /** The month's last day (`YYYY-MM-DD`, the instance's time zone): what a monthly cap's forecast runs to. */
  monthEnd: string;
}

/** A local model seen in the last 30 days (SP12, `GET /api/settings/ai-prices/local`). */
export interface AiLocalModel {
  /** The model as the rows name it (`qwen3-coder:30b`). */
  model: string;
  /** The local provider names it was seen under: `ollama` (Landflow's calls), `ollama_chat` (the gateway's). */
  providers: string[];
  calls: number;
  inputTokens: number;
  outputTokens: number;
  lastAt: string;
  /** The override that prices it now; absent: "Not priced". A new price applies from then on; recorded calls keep their cost. */
  price?: ModelPrice;
}
