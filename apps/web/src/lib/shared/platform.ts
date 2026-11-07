/**
 * Instance settings, variables and insights: types shared by the API routes and
 * the Settings and Insights pages. No runtime imports.
 */

export interface RetentionSettings {
  /** Keep at most this many finished executions (0 = no limit). */
  maxCount: number;
  /** Delete finished executions older than this many days (0 = keep). */
  maxAgeDays: number;
}

export interface InstanceSettings {
  /** IANA time zone used when a workflow doesn't set one (Date & Time nodes, Insights days; schedules once the scheduler reads it). */
  timezone: string;
  executions: RetentionSettings;
  /** json-render spec cards (docs/research/json-render-verdict.md). Unset: LANDFLOW_JSON_RENDER decides; a saved true/false wins. */
  jsonRender?: boolean;
}

/** A `$vars.NAME` value. */
export interface Variable {
  key: string;
  value: string;
}

export type InsightsPeriod = '24h' | '7d' | '30d';

export interface InsightsTotals {
  /** Finished runs: succeeded + failed + canceled. */
  runs: number;
  succeeded: number;
  failed: number;
  canceled: number;
  /** failed / runs (0–1); 0 without runs. */
  failureRate: number;
  avgDurationMs: number;
  /** Succeeded runs × the workflow's minutes saved per run. */
  timeSavedMinutes: number;
}

export interface InsightsBucket {
  /** ISO start of the hour (24h) or the day key `YYYY-MM-DD` in the instance time zone. */
  key: string;
  label: string;
  succeeded: number;
  failed: number;
  canceled: number;
}

export interface InsightsWorkflowRow extends InsightsTotals {
  workflowId: string;
  name: string;
  /** False when the workflow was deleted (its history stays in the rollup). */
  exists: boolean;
  /** The workflow's `settings.timeSavedMinutes`. */
  minutesSavedPerRun?: number;
}

export interface InsightsReport {
  period: InsightsPeriod;
  includeManual: boolean;
  timezone: string;
  current: InsightsTotals;
  previous: InsightsTotals;
  series: InsightsBucket[];
  workflows: InsightsWorkflowRow[];
  /** When the rollup was first filled from the executions on disk. */
  backfilledAt?: string;
}
