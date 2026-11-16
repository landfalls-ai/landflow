/**
 * Unusual AI spend and forecasts over a cap (SP23, docs/llm-gateway.md#forecasts-and-unusual-spend).
 *
 * The check is Landledger's, exactly (landledger `apps/api/src/anomalies.ts`, so one number means one thing in both
 * products): a day's value against the 14 days before it, robust to a bad day in the baseline. In integer micro-units,
 * the median of an even count rounded half to even, the MAD from the median, score = jump ÷ (1.4826 × MAD) to two
 * places (none when the MAD is 0, a flat baseline). Not judged under 7 observed days; anomalous when the jump over the
 * median is at least the smallest jump, at least half the median, and (unless flat) the score is at least 3.5.
 *
 * The scan runs on the leader every ten minutes (`aiSpendFlags`). For today and yesterday it checks each person, agent,
 * workflow, project and model; it also flags each monthly cap whose forecast reaches the cap while the month to date is
 * still under it. Both are rows of `ai_spend_flags` (`spend-flags.ts`); the alerts, Needs you and the brain read them
 * from there. Nothing here changes a cap, a budget or a run.
 */
import { addDays } from '../../shared/ai-forecast';
import { parseCapId } from '../../shared/llm-gateway';
import { agentStore } from '../agents/store';
import { getUser } from '../auth/users';
import { database, type Database } from '../db';
import { envWithAliases } from '../config';
import { homeProjectId, getProject } from '../projects/store';
import { singleton } from '../singleton';
import { store } from '../store';
import { logger } from '../telemetry/logger';
import { watchedCaps } from './alerts';
import { aiUsageMeter, aiUsageRetentionDays, type AiUsageMeter } from './index';
import { capForecaster } from './forecast';
import { deleteFlag, flagId, getFlag, listFlags, pruneFlags, saveFlag, surfaceWord, type SpendDimension, type SpendFlag } from './spend-flags';

// ---- the check --------------------------------------------------------------------------------------------

/** The days before the checked day the baseline reaches over, and how many of them must have been observed. */
export const BASELINE_DAYS = 14;
export const MIN_BASELINE_DAYS = 7;
/** A robust z-score of 3.5 (Iglewicz and Hoaglin), as hundredths, over the MAD scaled to σ (× 1.4826). */
export const MIN_SCORE_HUNDREDTHS = 350n;
const MAD_SCALE_TEN_THOUSANDTHS = 14_826n;
/** A key judged on tokens (no cost in any of its 15 days) needs a jump of at least this many input and output tokens. */
export const ANOMALY_MIN_TOKENS = 100_000;
const MICROS = 1_000_000;

const micro = (value: number): bigint => BigInt(Math.round(value * MICROS));
const unit = (micros: bigint): number => Number(micros) / MICROS;

/** The median of micro-unit amounts; with an even count, the mean of the middle two rounded half to even. */
export function median(xs: readonly bigint[]): bigint {
  if (!xs.length) return 0n;
  const sorted = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = sorted.length >> 1;
  if (sorted.length % 2) return sorted[mid]!;
  const sum = sorted[mid - 1]! + sorted[mid]!;
  const half = sum / 2n;
  if (sum % 2n === 0n) return half;
  const down = sum < 0n ? half - 1n : half;
  return down % 2n === 0n ? down : down + 1n;
}

/** The median absolute deviation from the median. */
export function mad(xs: readonly bigint[], med = median(xs)): bigint {
  return median(xs.map((x) => (x > med ? x - med : med - x)));
}

/** `n ÷ d` rounded half to even (`d` > 0). */
function divideHalfEven(n: bigint, d: bigint): bigint {
  const negative = n < 0n;
  const abs = negative ? -n : n;
  let quotient = abs / d;
  const twice = (abs % d) * 2n;
  if (twice > d || (twice === d && quotient % 2n === 1n)) quotient += 1n;
  return negative ? -quotient : quotient;
}

const hundredths = (value: bigint): string => `${value < 0n ? '-' : ''}${(value < 0n ? -value : value) / 100n}.${String((value < 0n ? -value : value) % 100n).padStart(2, '0')}`;

export interface SpendCheck {
  anomalous: boolean;
  /** In dollars or tokens, as the inputs. */
  median: number;
  mad: number;
  /** jump ÷ (1.4826 × MAD), two places; null when the baseline is flat (MAD 0). */
  score: string | null;
  /** Why not, when it isn't: in words. */
  reason: string;
}

/**
 * One day's value against its baseline (the observed days among the 14 before it). `baseline`, `observed` and `minJump` are
 * dollars (or tokens); the arithmetic is on millionths, so it is exact.
 */
export function checkSpend(baseline: readonly number[], observed: number, minJump: number): SpendCheck {
  const xs = baseline.map(micro);
  const med = median(xs);
  const spread = mad(xs, med);
  const jump = micro(observed) - med;
  const scoreHundredths = spread > 0n ? divideHalfEven(jump * 100n * 10_000n, spread * MAD_SCALE_TEN_THOUSANDTHS) : undefined;
  const base = { median: unit(med), mad: unit(spread), score: scoreHundredths === undefined ? null : hundredths(scoreHundredths) };
  if (baseline.length < MIN_BASELINE_DAYS) return { ...base, anomalous: false, reason: `${baseline.length} observed days, ${MIN_BASELINE_DAYS} needed` };
  if (jump < micro(minJump)) return { ...base, anomalous: false, reason: 'below the smallest jump' };
  if (jump * 2n < med) return { ...base, anomalous: false, reason: 'less than half the median above it' };
  if (scoreHundredths !== undefined && scoreHundredths < MIN_SCORE_HUNDREDTHS) return { ...base, anomalous: false, reason: `robust score ${base.score} under 3.5` };
  return { ...base, anomalous: true, reason: 'anomalous' };
}

/** `LANDFLOW_AI_ANOMALY_MIN_USD`: the smallest jump in dollars (default 1). */
export function anomalyMinUsd(): number {
  const value = Number(envWithAliases('LANDFLOW_AI_ANOMALY_MIN_USD'));
  return Number.isFinite(value) && value > 0 ? value : 1;
}

// ---- the scan ---------------------------------------------------------------------------------------------

interface Cell {
  cost: number;
  tokens: number;
}

interface RowKeys {
  project_id: string | null;
  agent_id: string | null;
  workflow_id: string | null;
  user_id: string | null;
  provider: string | null;
  model: string | null;
}

const DIMENSIONS: readonly SpendDimension[] = ['person', 'agent', 'workflow', 'project', 'model'];

const KEY_COLUMNS = 'project_id, agent_id, workflow_id, user_id, provider, model';

/** Per dimension, key and day: what was spent; the raw days also say the runs and the surfaces behind each. */
class Ledger {
  readonly cells = new Map<SpendDimension, Map<string, Map<string, Cell>>>();
  readonly runs = new Map<string, Set<string>>();
  readonly surfaces = new Map<string, Map<string, Cell>>();
  private readonly homes = new Map<string, string | undefined>();

  private home(kind: 'workflow' | 'agent', id: string) {
    const cacheKey = `${kind}:${id}`;
    if (!this.homes.has(cacheKey)) this.homes.set(cacheKey, homeProjectId(kind, id));
    return this.homes.get(cacheKey);
  }

  /** The key of `row` in a dimension; a row with no project counts under its workflow's or agent's home project (the AI page's rule). */
  keyOf(dimension: SpendDimension, row: RowKeys): string | undefined {
    switch (dimension) {
      case 'person':
        return row.user_id || undefined;
      case 'agent':
        return row.agent_id || undefined;
      case 'workflow':
        return row.workflow_id || undefined;
      case 'project':
        return row.project_id || (row.workflow_id ? this.home('workflow', row.workflow_id) : row.agent_id ? this.home('agent', row.agent_id) : undefined) || undefined;
      case 'model':
        return row.provider || row.model ? `${row.provider ?? ''}/${row.model ?? ''}` : undefined;
    }
  }

  add(row: RowKeys & { day: string; cost: number; tokens: number; run?: string | null; surface?: string | null }, raw: boolean) {
    for (const dimension of DIMENSIONS) {
      const key = this.keyOf(dimension, row);
      if (!key) continue;
      let keys = this.cells.get(dimension);
      if (!keys) this.cells.set(dimension, (keys = new Map()));
      let days = keys.get(key);
      if (!days) keys.set(key, (days = new Map()));
      const cell = days.get(row.day) ?? { cost: 0, tokens: 0 };
      cell.cost += Number(row.cost) || 0;
      cell.tokens += Number(row.tokens) || 0;
      days.set(row.day, cell);
      if (!raw) continue;
      const id = `${dimension}\u0000${key}\u0000${row.day}`;
      if (row.run) (this.runs.get(id) ?? this.runs.set(id, new Set()).get(id)!).add(row.run);
      const bySurface = this.surfaces.get(id) ?? this.surfaces.set(id, new Map()).get(id)!;
      const part = bySurface.get(row.surface ?? '') ?? { cost: 0, tokens: 0 };
      part.cost += Number(row.cost) || 0;
      part.tokens += Number(row.tokens) || 0;
      bySurface.set(row.surface ?? '', part);
    }
  }
}

/** Reads the 15 days: older ones from the rollup, yesterday and today from the raw rows (as the AI page's report does). */
function loadLedger(today: string, db: Database): { ledger: Ledger; first: string | undefined } {
  const yesterday = addDays(today, -1);
  const from = addDays(today, -(BASELINE_DAYS + 1));
  const ledger = new Ledger();
  for (const row of db.all<RowKeys & { day: string; cost: number; tokens: number }>(
    `SELECT day, ${KEY_COLUMNS}, COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens FROM ai_usage_daily WHERE day >= ? AND day < ? GROUP BY day, ${KEY_COLUMNS}`,
    from,
    yesterday,
  )) {
    ledger.add(row, false);
  }
  for (const row of db.all<RowKeys & { day: string; cost: number; tokens: number; run: string | null; surface: string | null }>(
    `SELECT day, ${KEY_COLUMNS}, surface, COALESCE(execution_id, session_id) AS run, COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens FROM ai_usage WHERE day >= ? GROUP BY day, ${KEY_COLUMNS}, surface, COALESCE(execution_id, session_id)`,
    yesterday,
  )) {
    ledger.add(row, true);
  }
  const first = db.get<{ first: string | null }>('SELECT MIN(day) AS first FROM ai_usage')?.first ?? undefined;
  return { ledger, first };
}

/** What the flag's subject is called now. */
function labelOf(dimension: SpendDimension, key: string): string {
  switch (dimension) {
    case 'person': {
      const user = getUser(key);
      return user?.name || user?.email || key;
    }
    case 'agent':
      return `agent “${agentStore.get(key)?.name ?? key}”`;
    case 'workflow':
      return `workflow “${store.getWorkflow(key)?.name ?? key}”`;
    case 'project':
      return `project “${getProject(key)?.name ?? key}”`;
    case 'model':
      return `model ${key}`;
  }
}

const AT_MOST_SURFACES = 3;

function surfacesOf(ledger: Ledger, id: string, metric: 'cost' | 'tokens'): string[] {
  const parts = [...(ledger.surfaces.get(id) ?? [])].filter(([, cell]) => cell[metric] > 0).sort((a, b) => b[1][metric] - a[1][metric]);
  return parts.slice(0, AT_MOST_SURFACES).map(([surface]) => surfaceWord(surface));
}

/** Check one day of every key in every dimension; the flags it finds are written (a day's flag is one row, so a write is an upsert). */
function scanAnomalies(today: string, now: number, db: Database): number {
  const { ledger, first } = loadLedger(today, db);
  if (!first) return 0;
  const nowIso = new Date(now).toISOString();
  const minUsd = anomalyMinUsd();
  const found = new Set<string>();
  const days = [addDays(today, -1), today];
  for (const day of days) {
    const window = Array.from({ length: BASELINE_DAYS }, (_, i) => addDays(day, -(BASELINE_DAYS - i))).filter((d) => d >= first);
    // Not judged under 7 observed days: nothing to compute.
    if (window.length < MIN_BASELINE_DAYS) continue;
    for (const dimension of DIMENSIONS) {
      for (const [key, days] of ledger.cells.get(dimension) ?? []) {
        const cell = days.get(day);
        if (!cell || (cell.cost <= 0 && cell.tokens <= 0)) continue;
        // A key with tokens but no cost in any of its 15 days (a local model nobody priced) is judged on tokens.
        const priced = [...window, day].some((d) => (days.get(d)?.cost ?? 0) > 0);
        const metric = priced ? 'cost' : 'tokens';
        const value = cell[metric];
        if (value <= 0) continue;
        const check = checkSpend(
          window.map((d) => days.get(d)?.[metric] ?? 0),
          value,
          metric === 'cost' ? minUsd : ANOMALY_MIN_TOKENS,
        );
        if (!check.anomalous) continue;
        const id = flagId('anomaly', day, dimension, key);
        found.add(id);
        const existing = getFlag(id, db);
        const evidence = `${dimension}\u0000${key}\u0000${day}`;
        const flag: SpendFlag = {
          id,
          kind: 'anomaly',
          day,
          dimension,
          key,
          label: labelOf(dimension, key),
          metric,
          value,
          baselineMedian: check.median,
          baselineMad: check.mad,
          ...(check.score !== null && { score: check.score }),
          baselineDays: window.length,
          runs: ledger.runs.get(evidence)?.size ?? 0,
          surfaces: surfacesOf(ledger, evidence, metric),
          firstAt: existing?.firstAt ?? nowIso,
          updatedAt: nowIso,
          ...(existing?.lastAlertValue !== undefined && { lastAlertValue: existing.lastAlertValue }),
        };
        if (existing?.acknowledgedAt) {
          // Acknowledged stays acknowledged until the day's value doubles; then it opens again.
          if (value < existing.value * 2) continue;
          saveFlag(flag, db);
        } else if (!existing || existing.value !== value || existing.runs !== flag.runs) {
          saveFlag(flag, db);
        }
      }
    }
  }
  // A day the rollup or a late import changed so that it no longer stands out loses its flag, unless someone acknowledged it.
  for (const flag of listFlags('anomaly', days[0]!, db)) {
    if (!found.has(flag.id) && !flag.acknowledgedAt) deleteFlag(flag.id, db);
  }
  return found.size;
}

/** Each monthly cap forecast to be reached: one flag for the cap and month, updated each pass, gone when it falls back under. */
function scanForecasts(today: string, now: number, meter: AiUsageMeter, db: Database): number {
  const monthStart = `${today.slice(0, 7)}-01`;
  const nowIso = new Date(now).toISOString();
  const forecaster = capForecaster(now, undefined, db);
  const hit = new Set<string>();
  for (const cap of watchedCaps(meter)) {
    if (cap.period !== 'month') continue;
    const parsed = parseCapId(cap.id);
    const fields = forecaster.forecast(cap);
    const forecast = fields?.forecast;
    // A cap already reached is the existing threshold alert's, not this.
    if (!parsed || !forecast || forecast.early || forecast.p50 < cap.max || forecast.monthToDate >= cap.max) continue;
    const id = flagId('forecast', monthStart, parsed.kind, cap.id);
    hit.add(id);
    const existing = getFlag(id, db);
    saveFlag(
      {
        id,
        kind: 'forecast',
        day: monthStart,
        dimension: parsed.kind,
        key: cap.id,
        label: cap.subject,
        metric: cap.metric,
        value: forecast.monthToDate,
        runs: 0,
        surfaces: [],
        capMax: cap.max,
        p50: forecast.p50,
        ...(fields.reachesOn && { reachesOn: fields.reachesOn }),
        firstAt: existing?.firstAt ?? nowIso,
        updatedAt: nowIso,
        ...(existing?.lastAlertValue !== undefined && { lastAlertValue: existing.lastAlertValue }),
        ...(existing?.acknowledgedBy && { acknowledgedBy: existing.acknowledgedBy }),
        ...(existing?.acknowledgedAt && { acknowledgedAt: existing.acknowledgedAt }),
      },
      db,
    );
  }
  // A cap that fell back under (or went away) loses its flag unless someone acknowledged it.
  for (const flag of listFlags('forecast', monthStart, db)) {
    if (flag.day === monthStart && !hit.has(flag.id) && !flag.acknowledgedAt) deleteFlag(flag.id, db);
  }
  return hit.size;
}

/** One pass: the anomalies of today and yesterday, the forecasts of this month, then the retention prune. */
export function scanSpendFlags(now = Date.now(), db: Database = database(), meter: AiUsageMeter = aiUsageMeter()): { anomalies: number; forecasts: number } {
  const today = meter.today(now);
  const anomalies = scanAnomalies(today, now, db);
  const forecasts = scanForecasts(today, now, meter, db);
  pruneFlags(meter.today(now - aiUsageRetentionDays() * 86_400_000), db);
  return { anomalies, forecasts };
}

const EVERY_MS = 10 * 60_000;

/** The leader's service: the first pass 60 s after start (the rollup's has run by then), then every 10 minutes. */
export const aiSpendFlags = singleton('ai-spend-flags', () => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = true;
  let generation = 0;

  function arm(delay: number, mine: number) {
    timer = setTimeout(() => {
      try {
        scanSpendFlags();
      } catch (error) {
        logger.warn('ai spend flags failed', { error: (error as Error).message });
      }
      if (!stopped && mine === generation) arm(EVERY_MS, mine);
    }, delay);
    timer.unref?.();
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      generation += 1;
      arm(60_000, generation);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
});
