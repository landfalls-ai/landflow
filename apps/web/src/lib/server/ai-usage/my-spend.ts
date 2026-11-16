/**
 * The You card on the AI page (docs/llm-gateway.md, "The AI page"): the caller's own AI spend, from their own rows only
 * (`ai_usage.user_id`), and their own user caps (their own set, or the default for everyone), never anyone else's
 * (docs/llm-gateway.md, "Who sees what", rule 5), each with the forecast card's own figure (`capForecaster`). Numbers and
 * names only: no prompt text, no run contents.
 */
import { database, type Database } from '../db';
import { userCaps } from './alerts';
import { capForecaster } from './forecast';
import { aiUsageMeter } from './index';
import { findPrice, priceOverrides } from './prices';
import { CALL_PURPOSE_LABELS, isCallPurpose } from '../../shared/ai-call';
import type { AiMySpend, AiSpendPeriod, AiSpendPoint, AiSpendRow, AiSpendTotals } from '../../shared/ai-spend';
import type { ModelPrice } from '../../shared/ai-usage';

const DAY_MS = 86_400_000;
const PERIOD_DAYS: Partial<Record<AiSpendPeriod, number>> = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 };
const GROUP_LIMIT = 50;

interface Sums {
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
  cost: number | null;
  calls: number | null;
}
const SUMS =
  'COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output, COALESCE(SUM(cache_read_tokens), 0) AS cache_read, COALESCE(SUM(cache_write_tokens), 0) AS cache_write, COALESCE(SUM(cost), 0) AS cost, COUNT(*) AS calls';
const RUN = 'COUNT(DISTINCT COALESCE(execution_id, session_id)) AS runs';

const emptyTotals = (): AiSpendTotals => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, calls: 0, unpricedCalls: 0, runs: 0 });

function addSums(into: AiSpendTotals, row: Sums) {
  into.inputTokens += Number(row.input ?? 0);
  into.outputTokens += Number(row.output ?? 0);
  into.cacheReadTokens += Number(row.cache_read ?? 0);
  into.cacheWriteTokens += Number(row.cache_write ?? 0);
  into.cost += Number(row.cost ?? 0);
  into.calls += Number(row.calls ?? 0);
}

/** The model has no price now and the calls cost nothing (a local model nobody priced, or one the table doesn't know). */
const isUnpriced = (price: ModelPrice | undefined, cost: number) => price === undefined && cost <= 0;

export function mySpend(userId: string, period: AiSpendPeriod = '7d', now: number = Date.now(), db: Database = database()): AiMySpend {
  const meter = aiUsageMeter();
  const overrides = priceOverrides(db);
  const today = meter.today(now);
  const days = PERIOD_DAYS[period] ?? 7;
  const kept: AiSpendPeriod = PERIOD_DAYS[period] ? period : '7d';
  const fromDay = meter.today(now - (days - 1) * DAY_MS);
  const monthStart = `${today.slice(0, 7)}-01`;
  // 24h is a rolling 24 hours by `at` (like the AI page's own 24h); the day periods are days by the `day` column.
  const rolling = kept === '24h';
  const fromAt = new Date(now - DAY_MS).toISOString();
  const toAt = new Date(now).toISOString();
  const periodWhere = rolling ? 'user_id = ? AND at >= ? AND at <= ?' : 'user_id = ? AND day >= ? AND day <= ?';
  const periodArgs = rolling ? [fromAt, toAt] : [fromDay, today];

  /** Totals over `day >= from` (and `day <= to`), summed over (provider, model) so unpriced calls can be counted by the price table. */
  const totalsFor = (from: string, to: string): AiSpendTotals => {
    const total = emptyTotals();
    const where = 'user_id = ? AND day >= ? AND day <= ?';
    const rows = db.all<Sums & { provider: string; model: string }>(`SELECT provider, model, ${SUMS} FROM ai_usage WHERE ${where} GROUP BY provider, model`, userId, from, to);
    for (const row of rows) {
      addSums(total, row);
      if (isUnpriced(findPrice(row.provider, row.model, overrides), Number(row.cost ?? 0))) total.unpricedCalls += Number(row.calls ?? 0);
    }
    total.runs = Number(db.get<{ runs: number }>(`SELECT ${RUN} FROM ai_usage WHERE ${where}`, userId, from, to)?.runs ?? 0);
    return { ...total, cost: round(total.cost) };
  };

  // One group of the period: its rows, the tail beyond 50 rolled into "Other".
  const groupBy = (column: 'surface' | 'purpose' | 'model', labelOf: (key: string, provider?: string) => string): AiSpendRow[] => {
    const where = periodWhere;
    const keyExpr = column === 'model' ? "provider || '/' || model" : `COALESCE(${column}, 'none')`;
    const rows = db.all<Sums & { grp: string; provider: string; model: string }>(`SELECT ${keyExpr} AS grp, provider, model, ${SUMS} FROM ai_usage WHERE ${where} GROUP BY ${keyExpr}, provider, model`, userId, ...periodArgs);
    const runs = new Map(db.all<{ grp: string; runs: number }>(`SELECT ${keyExpr} AS grp, ${RUN} FROM ai_usage WHERE ${where} GROUP BY ${keyExpr}`, userId, ...periodArgs).map((r) => [r.grp, Number(r.runs)]));
    const map = new Map<string, AiSpendRow>();
    for (const row of rows) {
      let entry = map.get(row.grp);
      if (!entry) {
        entry = { ...emptyTotals(), key: row.grp, label: labelOf(row.grp, row.provider), share: 0, runs: runs.get(row.grp) ?? 0 };
        map.set(row.grp, entry);
      }
      addSums(entry, row);
      const unpriced = isUnpriced(findPrice(row.provider, row.model, overrides), Number(row.cost ?? 0));
      if (unpriced) entry.unpricedCalls += Number(row.calls ?? 0);
      if (column === 'model' && unpriced) entry.unpriced = true;
    }
    // The same model through two providers keeps one row each: name the provider when labels collide.
    if (column === 'model') {
      const counts = new Map<string, number>();
      for (const entry of map.values()) counts.set(entry.label, (counts.get(entry.label) ?? 0) + 1);
      for (const [key, entry] of map) if ((counts.get(entry.label) ?? 0) > 1) entry.label = `${entry.label} (${key.slice(0, key.indexOf('/'))})`;
    }
    return finish([...map.values()]);
  };

  const hourlySeries = (): AiSpendPoint[] => {
    const hour = 3_600_000;
    const last = Math.floor(now / hour) * hour;
    const first = last - 23 * hour;
    const rows = db.all<{ at: string; input_tokens: number; output_tokens: number; cache_read_tokens: number | null; cost: number; }>(
      'SELECT at, input_tokens, output_tokens, cache_read_tokens, cost FROM ai_usage WHERE user_id = ? AND at >= ? AND at <= ?',
      userId,
      new Date(first).toISOString(),
      toAt,
    );
    const points: AiSpendPoint[] = [];
    for (let i = 0; i < 24; i++) points.push({ at: new Date(first + i * hour).toISOString(), cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 });
    for (const row of rows) {
      const index = Math.floor((Date.parse(row.at) - first) / hour);
      const point = points[index];
      if (!point) continue;
      point.cost += Number(row.cost ?? 0);
      point.inputTokens += Number(row.input_tokens ?? 0);
      point.outputTokens += Number(row.output_tokens ?? 0);
      point.cacheReadTokens += Number(row.cache_read_tokens ?? 0);
      point.calls += 1;
    }
    for (const point of points) point.cost = round(point.cost);
    return points;
  };

  const series = (): AiSpendPoint[] => {
    if (rolling) return hourlySeries();
    const rows = db.all<Sums & { day: string }>(`SELECT day, ${SUMS} FROM ai_usage WHERE user_id = ? AND day >= ? AND day <= ? GROUP BY day`, userId, fromDay, today);
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const points: AiSpendPoint[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const at = meter.today(now - i * DAY_MS);
      const row = byDay.get(at);
      points.push({ at, cost: round(Number(row?.cost ?? 0)), inputTokens: Number(row?.input ?? 0), outputTokens: Number(row?.output ?? 0), cacheReadTokens: Number(row?.cache_read ?? 0), calls: Number(row?.calls ?? 0) });
    }
    return points;
  };

  return {
    today: totalsFor(today, today),
    month: totalsFor(monthStart, today),
    period: kept,
    from: rolling ? fromAt : fromDay,
    to: rolling ? toAt : today,
    series: series(),
    byModel: groupBy('model', (key) => key.slice(key.indexOf('/') + 1)),
    byPurpose: groupBy('purpose', (key) => (key === 'none' ? 'No purpose' : isCallPurpose(key) ? CALL_PURPOSE_LABELS[key] : key)),
    bySurface: groupBy('surface', (key) => (key === 'none' ? 'No surface' : key)),
    ...myCaps(userId, now, db),
  };
}

const round = (value: number) => Math.round(value * 1e6) / 1e6;

/** Sorted by cost then tokens, each with its share, the tail beyond 50 as "Other". */
function finish(rows: AiSpendRow[]): AiSpendRow[] {
  const whole = rows.reduce((sum, r) => sum + r.cost, 0);
  const byCost = whole > 0;
  const size = (r: AiSpendRow) => (byCost ? r.cost : r.inputTokens + r.outputTokens);
  const total = rows.reduce((sum, r) => sum + size(r), 0);
  const sorted = [...rows].sort((a, b) => b.cost - a.cost || b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) || a.label.localeCompare(b.label));
  const shown = sorted.slice(0, GROUP_LIMIT).map((r) => ({ ...r, cost: round(r.cost), share: total > 0 ? size(r) / total : 0 }));
  if (sorted.length > GROUP_LIMIT) {
    const rest: AiSpendRow = { ...emptyTotals(), key: 'other', label: 'Other', share: 0 };
    for (const r of sorted.slice(GROUP_LIMIT)) {
      rest.inputTokens += r.inputTokens;
      rest.outputTokens += r.outputTokens;
      rest.cacheReadTokens += r.cacheReadTokens;
      rest.cacheWriteTokens += r.cacheWriteTokens;
      rest.cost += r.cost;
      rest.calls += r.calls;
      rest.unpricedCalls += r.unpricedCalls;
      rest.runs += r.runs;
    }
    rest.cost = round(rest.cost);
    rest.share = total > 0 ? size(rest) / total : 0;
    shown.push(rest);
  }
  return shown;
}

/**
 * The caller's own user caps only: their own set, or the default for everyone (docs/llm-gateway.md, "Who sees what",
 * rule 5), each with the forecast card's figure for the same cap: `forecast` and `reachesOn` monthly, `pace` daily.
 */
function myCaps(userId: string, now: number, db: Database): Pick<AiMySpend, 'caps' | 'monthEnd'> {
  const pending = new Map(
    db
      .all<{ id: string; cap_id: string }>(`SELECT id, cap_id FROM ai_cap_requests WHERE requested_by = ? AND status IN ('pending', 'asking') ORDER BY created_at`, userId)
      .map((row) => [row.cap_id, row.id]),
  );
  const forecaster = capForecaster(now, userId, db);
  const caps = userCaps(userId)
    .map((cap) => {
      const requestId = pending.get(cap.id);
      return {
        id: cap.id,
        subject: cap.subject,
        period: cap.period,
        metric: cap.metric,
        max: cap.max,
        used: cap.used,
        ratio: cap.max > 0 ? cap.used / cap.max : 0,
        setIn: cap.setIn,
        link: cap.link,
        canRequest: true,
        ...(requestId && { pendingRequestId: requestId }),
        ...forecaster.forecast(cap),
      };
    })
    .sort((a, b) => b.ratio - a.ratio);
  return { caps, monthEnd: forecaster.monthEnd };
}
