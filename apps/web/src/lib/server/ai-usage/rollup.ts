/**
 * The daily rollup of `ai_usage` (SP08, docs/llm-gateway.md "The AI page"): one row per day and per distinct combination
 * of the columns the AI page groups and filters by, so 90 days and custom ranges of up to 400 days stay fast. `ai_usage`
 * itself is kept as long (`LANDFLOW_AI_USAGE_RETENTION_DAYS`); the rollup is for speed, not for a longer memory.
 *
 * A leader service recomputes today, yesterday, every day since the last pass (`meta` `ai_spend_rolled_through`, so a host that
 * was off for days loses nothing) and every day marked dirty every 10 minutes, a week of days at a time with the event loop
 * free between steps (`runRollupInBatches`). A day is rewritten whole in
 * one transaction through the row-level calls (`delete`, `upsert`), never a raw statement: Postgres mode replays those
 * calls and nothing else. Days marked dirty (a late import wrote a row into a past day) live in the `meta` table, so a
 * leader change loses none.
 */
import { database } from '../db';
import type { Database, SqlValue } from '../db/database';
import { logger } from '../telemetry/logger';
import { singleton } from '../singleton';
import { aiUsageMeter, aiUsageRetentionDays } from './index';

const DAY_MS = 86_400_000;
const EVERY_MS = 10 * 60_000;
const DIRTY_KEY = 'ai_spend_dirty_days';
const THROUGH_KEY = 'ai_spend_rolled_through';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The twelve key columns of `ai_usage_daily` after `day`, in primary-key order. */
export const ROLLUP_KEYS = [
  'project_id',
  'goal_id',
  'agent_id',
  'workflow_id',
  'user_id',
  'credential_id',
  'surface',
  'purpose',
  'provider',
  'model',
  'source',
  'runtime',
] as const;

interface DayRow extends Record<string, SqlValue> {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  calls: number;
  runs: number;
  cost: number;
}

const coalesced = ROLLUP_KEYS.map((key) => `COALESCE(${key}, '') AS ${key}`).join(', ');

function dirtyDays(db: Database): string[] {
  try {
    const parsed = JSON.parse(db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', DIRTY_KEY)?.value ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((day): day is string => typeof day === 'string' && DAY.test(day)) : [];
  } catch {
    return [];
  }
}

/** Mark days whose raw rows changed after they were rolled up (a late import); the next pass recomputes them. */
export function markSpendDays(days: Iterable<string>, db: Database = database()) {
  const add = [...new Set(days)].filter((day) => DAY.test(day));
  if (!add.length) return;
  db.transaction(() => {
    const all = new Set([...dirtyDays(db), ...add]);
    db.upsert('meta', {
      key: DIRTY_KEY,
      value: JSON.stringify([...all].sort()),
    });
  });
}

/**
 * Rewrite one day of the rollup from the raw rows (an empty day leaves no rows). The read, the day's dirty mark's removal, the
 * delete and the upserts are one transaction in one synchronous tick: the mark goes only with the rewrite that saw the rows
 * it stood for (a throw or a kill leaves it), and a mark set later, during a pause between batches, is for newer rows and stays.
 */
export function rollupDay(day: string, db: Database = database()): number {
  return db.transaction(() => {
    const rows = db.all<DayRow>(
      `SELECT ${coalesced},
       COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
       COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens, COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
       COUNT(*) AS calls, COUNT(DISTINCT COALESCE(execution_id, session_id)) AS runs, COALESCE(SUM(cost), 0) AS cost
     FROM ai_usage WHERE day = ?
     GROUP BY ${ROLLUP_KEYS.map((key) => `COALESCE(${key}, '')`).join(', ')}`,
      day,
    );
    const marked = dirtyDays(db);
    if (marked.includes(day)) {
      const rest = marked.filter((d) => d !== day);
      if (rest.length) db.upsert('meta', { key: DIRTY_KEY, value: JSON.stringify(rest) });
      else db.delete('meta', { key: DIRTY_KEY });
    }
    db.delete('ai_usage_daily', { day });
    for (const row of rows) {
      db.upsert('ai_usage_daily', {
        day,
        ...Object.fromEntries(ROLLUP_KEYS.map((key) => [key, String(row[key] ?? '')])),
        input_tokens: Number(row.input_tokens),
        output_tokens: Number(row.output_tokens),
        cache_read_tokens: Number(row.cache_read_tokens),
        cache_write_tokens: Number(row.cache_write_tokens),
        calls: Number(row.calls),
        runs: Number(row.runs),
        cost: Number(row.cost),
      });
    }
    return rows.length;
  });
}

/** What one pass recomputes: today, yesterday, every day since the last pass (up to the retention) and the dirty days, oldest first. */
function planPass(now: number, db: Database): string[] {
  const meter = aiUsageMeter();
  // Around a time-zone change of clocks "a day ago" can name the same day twice or skip one: ask around it.
  const days = new Set<string>([meter.today(now), meter.today(now - DAY_MS), meter.today(now - DAY_MS - 3_600_000), meter.today(now - DAY_MS + 3_600_000)]);
  // A host that was off for days (a weekend, a laptop shut overnight) never rolled up the days between: every pass starts again
  // from the last day it rolled up, capped at the retention, so a call recorded after that day's last pass is not lost.
  const through = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', THROUGH_KEY)?.value;
  if (through && DAY.test(through)) {
    for (let back = 2, max = aiUsageRetentionDays(); back <= max; back++) {
      const day = meter.today(now - back * DAY_MS);
      if (day < through) break;
      days.add(day);
    }
  }
  for (const day of dirtyDays(db)) days.add(day);
  return [...days].sort();
}

/** The end of a pass: the day it reached and the retention prune. The dirty marks were taken, batch by batch, as the days were rolled. */
function finishPass(now: number, db: Database) {
  const meter = aiUsageMeter();
  db.upsert('meta', { key: THROUGH_KEY, value: meter.today(now) });
  db.deleteBefore('ai_usage_daily', 'day', meter.today(now - aiUsageRetentionDays() * DAY_MS));
}

/**
 * One pass, in one go: today, yesterday, the days since the last pass and the dirty days (every day it recomputed is
 * returned), then the retention prune. The leader's service runs `runRollupInBatches`, which does the same in steps.
 */
export function runRollup(now = Date.now(), db: Database = database()): string[] {
  const days = planPass(now, db);
  for (const day of days) rollupDay(day, db);
  finishPass(now, db);
  return days;
}

const BATCH_DAYS = 7;
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The same pass as `runRollup`, a week of days per step with `pause` (the event loop by default) between steps, so a host
 * off for days, or the first pass over 400 days, doesn't hold the leader's event loop for the whole of it. `through` moves
 * only at the end, so a pass cut short starts from the same day again. `halt` is asked between steps: true ends the pass
 * there (the days rolled so far are returned, `through` stays).
 */
export async function runRollupInBatches(now = Date.now(), db: Database = database(), pause: () => Promise<void> = yieldToEventLoop, batchDays = BATCH_DAYS, halt: () => boolean = () => false): Promise<string[]> {
  const days = planPass(now, db);
  const done: string[] = [];
  for (let i = 0; i < days.length; i += batchDays) {
    if (i > 0) {
      await pause();
      if (halt()) return done;
    }
    const batch = days.slice(i, i + batchDays);
    for (const day of batch) rollupDay(day, db);
    done.push(...batch);
  }
  finishPass(now, db);
  return done;
}

/** The leader's service: the first pass 15 s after start, then every 10 minutes. */
export const aiSpendRollup = singleton('ai-spend-rollup', () => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = true;
  // Each start is a generation: a pass of an older one halts between batches and never re-arms, so stop() then start() leaves one timer.
  let generation = 0;

  function arm(delay: number, mine: number) {
    timer = setTimeout(() => {
      runRollupInBatches(Date.now(), database(), yieldToEventLoop, BATCH_DAYS, () => stopped || mine !== generation)
        .catch((error) => logger.warn('ai spend rollup failed', { error: (error as Error).message }))
        .finally(() => {
          if (!stopped && mine === generation) arm(EVERY_MS, mine);
        });
    }, delay);
    timer.unref?.();
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      generation += 1;
      arm(15_000, generation);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
});
