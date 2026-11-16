/**
 * The daily rollup of `ai_usage` (SP08, docs/llm-gateway.md "The AI page"): one row per day and per distinct combination
 * of the columns the AI page groups and filters by, so 90 days and custom ranges of up to 400 days stay fast. `ai_usage`
 * itself is kept as long (`LANDFLOW_AI_USAGE_RETENTION_DAYS`); the rollup is for speed, not for a longer memory.
 *
 * A leader service recomputes today, yesterday and every day marked dirty every 10 minutes. A day is rewritten whole in
 * one transaction through the row-level calls (`delete`, `upsert`), never a raw statement: Postgres mode replays those
 * calls and nothing else. Days marked dirty (a late import wrote a row into a past day) live in the `meta` table, so a
 * leader change loses none.
 */
import { database } from "../db";
import type { Database, SqlValue } from "../db/database";
import { logger } from "../telemetry/logger";
import { singleton } from "../singleton";
import { aiUsageMeter, aiUsageRetentionDays } from "./index";

const DAY_MS = 86_400_000;
const EVERY_MS = 10 * 60_000;
const DIRTY_KEY = "ai_spend_dirty_days";
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The twelve key columns of `ai_usage_daily` after `day`, in primary-key order. */
export const ROLLUP_KEYS = [
  "project_id",
  "goal_id",
  "agent_id",
  "workflow_id",
  "user_id",
  "credential_id",
  "surface",
  "purpose",
  "provider",
  "model",
  "source",
  "runtime",
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

const keyList = ROLLUP_KEYS.join(", ");
const coalesced = ROLLUP_KEYS.map(
  (key) => `COALESCE(${key}, '') AS ${key}`,
).join(", ");

function dirtyDays(db: Database): string[] {
  try {
    const parsed = JSON.parse(
      db.get<{ value: string }>(
        "SELECT value FROM meta WHERE key = ?",
        DIRTY_KEY,
      )?.value ?? "[]",
    ) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (day): day is string => typeof day === "string" && DAY.test(day),
        )
      : [];
  } catch {
    return [];
  }
}

/** Mark days whose raw rows changed after they were rolled up (a late import); the next pass recomputes them. */
export function markSpendDays(
  days: Iterable<string>,
  db: Database = database(),
) {
  const add = [...new Set(days)].filter((day) => DAY.test(day));
  if (!add.length) return;
  db.transaction(() => {
    const all = new Set([...dirtyDays(db), ...add]);
    db.upsert("meta", {
      key: DIRTY_KEY,
      value: JSON.stringify([...all].sort()),
    });
  });
}

/** Rewrite one day of the rollup from the raw rows (an empty day leaves no rows). */
export function rollupDay(day: string, db: Database = database()): number {
  const rows = db.all<DayRow>(
    `SELECT ${coalesced},
       COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
       COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens, COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
       COUNT(*) AS calls, COUNT(DISTINCT COALESCE(execution_id, session_id)) AS runs, COALESCE(SUM(cost), 0) AS cost
     FROM ai_usage WHERE day = ?
     GROUP BY ${ROLLUP_KEYS.map((key) => `COALESCE(${key}, '')`).join(", ")}`,
    day,
  );
  db.transaction(() => {
    db.delete("ai_usage_daily", { day });
    for (const row of rows) {
      db.upsert("ai_usage_daily", {
        day,
        ...Object.fromEntries(
          ROLLUP_KEYS.map((key) => [key, String(row[key] ?? "")]),
        ),
        input_tokens: Number(row.input_tokens),
        output_tokens: Number(row.output_tokens),
        cache_read_tokens: Number(row.cache_read_tokens),
        cache_write_tokens: Number(row.cache_write_tokens),
        calls: Number(row.calls),
        runs: Number(row.runs),
        cost: Number(row.cost),
      });
    }
  });
  return rows.length;
}

/** One pass: today, yesterday and the dirty days; then the retention prune. Returns the days it recomputed. */
export function runRollup(
  now = Date.now(),
  db: Database = database(),
): string[] {
  const meter = aiUsageMeter();
  // Around a time-zone change of clocks "a day ago" can name the same day twice or skip one: ask around it.
  const days = new Set<string>([
    meter.today(now),
    meter.today(now - DAY_MS),
    meter.today(now - DAY_MS - 3_600_000),
    meter.today(now - DAY_MS + 3_600_000),
  ]);
  const dirty = dirtyDays(db);
  for (const day of dirty) days.add(day);
  const done: string[] = [];
  for (const day of [...days].sort()) {
    rollupDay(day, db);
    done.push(day);
  }
  // Clear only what was marked before the pass: a day marked while it ran stays for the next one.
  if (dirty.length) {
    db.transaction(() => {
      const rest = dirtyDays(db).filter((day) => !dirty.includes(day));
      if (rest.length)
        db.upsert("meta", { key: DIRTY_KEY, value: JSON.stringify(rest) });
      else db.delete("meta", { key: DIRTY_KEY });
    });
  }
  db.deleteBefore(
    "ai_usage_daily",
    "day",
    meter.today(now - aiUsageRetentionDays() * DAY_MS),
  );
  return done;
}

/** The leader's service: the first pass 15 s after start, then every 10 minutes. */
export const aiSpendRollup = singleton("ai-spend-rollup", () => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = true;

  function arm(delay: number) {
    timer = setTimeout(() => {
      try {
        runRollup();
      } catch (error) {
        logger.warn("ai spend rollup failed", {
          error: (error as Error).message,
        });
      }
      if (!stopped) arm(EVERY_MS);
    }, delay);
    timer.unref?.();
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      arm(15_000);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
});
