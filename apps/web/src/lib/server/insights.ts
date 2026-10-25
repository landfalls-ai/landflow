/**
 * Insights: a rollup of finished executions per workflow, so run counts,
 * failure rates, durations and time saved survive execution pruning. Kept in
 * <data dir>/insights.json:
 *
 *   days   workflow → day (YYYY-MM-DD in the instance time zone) → counts, for 400 days
 *   hours  workflow → UTC hour (YYYY-MM-DDTHH) → counts, for the last 49 hours (exact 24 h figures)
 *
 * Each bucket splits production runs from manual ones (editor runs and its chat
 * panel). store.saveExecution feeds every finished execution through
 * `recordExecutionInsights`; bootstrap backfills the rollup once from the
 * executions already on disk. Writes are debounced (1 s) and flushed on exit.
 *
 * Queue mode: every main and worker keeps its own rollup (insights.<instance>.json, the runs it finished) in the shared
 * data directory, and a report adds up all of them (and insights.json from before queue mode).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Workflow } from '@landflow/engine';
import type { InsightsBucket, InsightsPeriod, InsightsReport, InsightsTotals, InsightsWorkflowRow } from '../shared/platform';
import type { ExecutionSummary } from '../shared/types';
import { clusterState } from './cluster/state';
import { instanceTimezone } from './settings';
import { singleton } from './singleton';
import { atomicWrite, store } from './store';

export type { InsightsPeriod, InsightsReport };

/** What the rollup needs from an execution (an ExecutionSummary has it). */
export type RecordedExecution = Pick<ExecutionSummary, 'id' | 'workflowId' | 'workflowName' | 'mode' | 'status' | 'startedAt' | 'durationMs' | 'evaluation'>;

interface Counts {
  succeeded: number;
  failed: number;
  canceled: number;
  durationMs: number;
}

interface Bucket {
  production?: Counts;
  manual?: Counts;
}

interface RollupData {
  version: 1;
  backfilledAt?: string;
  /** Last name seen per workflow, so deleted workflows still have one. */
  names: Record<string, string>;
  days: Record<string, Record<string, Bucket>>;
  hours: Record<string, Record<string, Bucket>>;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const KEEP_HOURS = 49;
const KEEP_DAYS = 400;
/** Runs started from the editor (Execute, its chat panel): left out of the KPIs unless asked for. */
export const MANUAL_MODES = new Set(['manual', 'chat']);
const STATUS_FIELD: Record<string, keyof Counts | undefined> = { success: 'succeeded', error: 'failed', canceled: 'canceled' };

const empty = (): Counts => ({ succeeded: 0, failed: 0, canceled: 0, durationMs: 0 });
const runsOf = (c: Counts) => c.succeeded + c.failed + c.canceled;

function add(into: Counts, from: Counts | undefined) {
  if (!from) return;
  into.succeeded += from.succeeded;
  into.failed += from.failed;
  into.canceled += from.canceled;
  into.durationMs += from.durationMs;
}

/** `YYYY-MM-DD` of an instant in a time zone. */
export function dayKey(ms: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

const hourKey = (ms: number) => new Date(ms).toISOString().slice(0, 13);

/** The day key `offset` calendar days from `key` (negative = earlier). */
function shiftDay(key: string, offset: number): string {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) + offset * DAY_MS).toISOString().slice(0, 10);
}

function load(path: string): RollupData {
  try {
    const saved = JSON.parse(readFileSync(path, 'utf8')) as Partial<RollupData>;
    if (saved && typeof saved === 'object') {
      return { version: 1, ...(saved.backfilledAt && { backfilledAt: saved.backfilledAt }), names: saved.names ?? {}, days: saved.days ?? {}, hours: saved.hours ?? {} };
    }
  } catch {
    // No rollup yet.
  }
  return { version: 1, names: {}, days: {}, hours: {} };
}

/** Add one rollup's buckets and names to another. */
function merge(into: RollupData, from: RollupData) {
  for (const source of ['days', 'hours'] as const) {
    for (const [workflowId, byKey] of Object.entries(from[source])) {
      const target = (into[source][workflowId] ??= {});
      for (const [key, bucket] of Object.entries(byKey)) {
        const counts = (target[key] ??= {});
        for (const kind of ['production', 'manual'] as const) if (bucket[kind]) add((counts[kind] ??= empty()), bucket[kind]);
      }
    }
  }
  for (const [workflowId, name] of Object.entries(from.names)) into.names[workflowId] ??= name;
  if (!into.backfilledAt && from.backfilledAt) into.backfilledAt = from.backfilledAt;
}

function totals(counts: Counts, minutes = 0): InsightsTotals {
  const runs = runsOf(counts);
  return {
    runs,
    succeeded: counts.succeeded,
    failed: counts.failed,
    canceled: counts.canceled,
    failureRate: runs ? counts.failed / runs : 0,
    avgDurationMs: runs ? Math.round(counts.durationMs / runs) : 0,
    timeSavedMinutes: counts.succeeded * minutes,
  };
}

export interface ReportOptions {
  period: InsightsPeriod;
  includeManual?: boolean;
  /** Current workflows: names, whether a workflow still exists, and its minutes saved per run. */
  workflows?: Array<Pick<Workflow, 'id' | 'name' | 'settings'>>;
  /** Count only these workflows (a member's insights cover the workflows they see). */
  only?: Set<string>;
  now?: number;
}

/** The rollup behind one insights.json. The default instance lives in the data directory; tests make their own. */
export class InsightsRollup {
  private data: RollupData;
  /** Executions counted by this process, so saving the same finished run twice counts it once. */
  private readonly counted = new Set<string>();
  private timer?: NodeJS.Timeout;
  private lastTrim = 0;

  constructor(
    readonly path: string,
    private readonly timezone: () => string = instanceTimezone,
  ) {
    this.data = load(path);
  }

  get backfilledAt(): string | undefined {
    return this.data.backfilledAt;
  }

  /** Add one execution. Unfinished ones (running, waiting), evaluation runs and ones already counted are ignored. Returns whether it counted. */
  record(execution: RecordedExecution, now = Date.now()): boolean {
    const field = STATUS_FIELD[execution.status];
    const started = Date.parse(execution.startedAt);
    if (!field || !execution.workflowId || execution.evaluation || Number.isNaN(started) || this.counted.has(execution.id)) return false;
    this.counted.add(execution.id);
    if (this.counted.size > 20_000) this.counted.delete(this.counted.values().next().value!);

    const kind = MANUAL_MODES.has(execution.mode) ? 'manual' : 'production';
    const bump = (bucket: Bucket) => {
      const counts = (bucket[kind] ??= empty());
      counts[field] += 1;
      counts.durationMs += Math.max(0, Math.round(execution.durationMs || 0));
    };
    const timezone = this.timezone();
    const day = dayKey(started, timezone);
    if (day >= shiftDay(dayKey(now, timezone), -KEEP_DAYS)) bump(((this.data.days[execution.workflowId] ??= {})[day] ??= {}));
    if (started >= now - KEEP_HOURS * HOUR_MS) bump(((this.data.hours[execution.workflowId] ??= {})[hourKey(started)] ??= {}));
    if (execution.workflowName) this.data.names[execution.workflowId] = execution.workflowName;
    this.trim(now);
    this.schedule();
    return true;
  }

  /** Fill the rollup from existing executions, once per rollup file. Returns how many were added (0 when already done). */
  backfill(executions: RecordedExecution[], now = Date.now()): number {
    if (this.data.backfilledAt) return 0;
    let added = 0;
    // Queue mode: another process's rollup (or the one from before queue mode) already counted what is on disk.
    if (!this.peers().some((peer) => peer.backfilledAt)) for (const execution of executions) if (this.record(execution, now)) added++;
    this.data.backfilledAt = new Date(now).toISOString();
    this.flush();
    return added;
  }

  /** KPIs for the period and the one before it, a series for the chart and a row per workflow that ran. */
  report(options: ReportOptions): InsightsReport {
    const now = options.now ?? Date.now();
    const includeManual = Boolean(options.includeManual);
    const timezone = this.timezone();
    const pick = (bucket: Bucket | undefined, into: Counts) => {
      add(into, bucket?.production);
      if (includeManual) add(into, bucket?.manual);
    };

    // The keys of the current period (oldest first) and of the previous one.
    let source: 'hours' | 'days';
    let keys: string[];
    let previousKeys: string[];
    let label: (key: string) => string;
    if (options.period === '24h') {
      source = 'hours';
      const top = Math.floor(now / HOUR_MS) * HOUR_MS;
      keys = Array.from({ length: 24 }, (_, i) => hourKey(top - (23 - i) * HOUR_MS));
      previousKeys = Array.from({ length: 24 }, (_, i) => hourKey(top - (47 - i) * HOUR_MS));
      const format = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit' });
      label = (key) => format.format(Date.parse(`${key}:00:00Z`));
    } else {
      source = 'days';
      const length = options.period === '7d' ? 7 : 30;
      const today = dayKey(now, timezone);
      keys = Array.from({ length }, (_, i) => shiftDay(today, i - length + 1));
      previousKeys = Array.from({ length }, (_, i) => shiftDay(today, i - 2 * length + 1));
      const format = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
      label = (key) => format.format(Date.parse(`${key}T00:00:00Z`));
    }

    // Queue mode: with the other processes' rollups.
    const peers = this.peers();
    const data = peers.length ? peers.reduce((all, peer) => (merge(all, peer), all), structuredClone(this.data)) : this.data;
    const buckets = data[source];
    const minutesOf = new Map((options.workflows ?? []).map((w) => [w.id, Math.max(0, Number(w.settings?.timeSavedMinutes) || 0)]));
    const current = empty();
    const previous = empty();
    let timeSaved = 0;
    let previousTimeSaved = 0;
    const series: InsightsBucket[] = keys.map((key) => ({ key, label: label(key), succeeded: 0, failed: 0, canceled: 0 }));
    const rows: InsightsWorkflowRow[] = [];

    for (const [workflowId, byKey] of Object.entries(buckets)) {
      if (options.only && !options.only.has(workflowId)) continue;
      const minutes = minutesOf.get(workflowId) ?? 0;
      const mine = empty();
      keys.forEach((key, index) => {
        const counts = empty();
        pick(byKey[key], counts);
        add(mine, counts);
        series[index].succeeded += counts.succeeded;
        series[index].failed += counts.failed;
        series[index].canceled += counts.canceled;
      });
      const before = empty();
      for (const key of previousKeys) pick(byKey[key], before);
      add(current, mine);
      add(previous, before);
      timeSaved += mine.succeeded * minutes;
      previousTimeSaved += before.succeeded * minutes;
      if (runsOf(mine) > 0) {
        const workflow = options.workflows?.find((w) => w.id === workflowId);
        rows.push({
          workflowId,
          name: workflow?.name ?? data.names[workflowId] ?? workflowId,
          exists: Boolean(workflow),
          ...(workflow?.settings?.timeSavedMinutes !== undefined && { minutesSavedPerRun: minutes }),
          ...totals(mine, minutes),
        });
      }
    }
    rows.sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name));

    return {
      period: options.period,
      includeManual,
      timezone,
      current: { ...totals(current), timeSavedMinutes: timeSaved },
      previous: { ...totals(previous), timeSavedMinutes: previousTimeSaved },
      series,
      workflows: rows,
      ...(data.backfilledAt && { backfilledAt: data.backfilledAt }),
    };
  }

  /** The other rollups in this one's directory (queue mode: insights.<instance>.json of the other processes), read fresh. */
  private peers(): RollupData[] {
    const own = basename(this.path);
    let names: string[];
    try {
      names = readdirSync(dirname(this.path));
    } catch {
      return [];
    }
    return names.filter((name) => name !== own && /^insights(\.[\w.-]+)?\.json$/.test(name)).map((name) => load(join(dirname(this.path), name)));
  }

  /** Write the rollup now (otherwise it is written a second after the last change). */
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    atomicWrite(this.path, this.data);
  }

  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      try {
        this.flush();
      } catch {
        // Not worth a crash (a full disk): the next change writes it again.
      }
    }, 1_000);
    this.timer.unref?.();
  }

  /** Drop hour buckets past 49 h and day buckets past 400 days, at most once an hour. */
  private trim(now: number) {
    if (now - this.lastTrim < HOUR_MS) return;
    this.lastTrim = now;
    const oldestHour = hourKey(now - KEEP_HOURS * HOUR_MS);
    const oldestDay = shiftDay(dayKey(now, this.timezone()), -KEEP_DAYS);
    for (const [source, oldest] of [['hours', oldestHour], ['days', oldestDay]] as const) {
      for (const [workflowId, byKey] of Object.entries(this.data[source])) {
        for (const key of Object.keys(byKey)) if (key < oldest) delete byKey[key];
        if (!Object.keys(byKey).length) delete this.data[source][workflowId];
      }
    }
  }
}

/** The instance's rollup (<data dir>/insights.json; queue mode: insights.<instance>.json), flushed when the process exits. */
export function insightsRollup(): InsightsRollup {
  return singleton('insights', () => {
    const { config } = clusterState();
    const rollup = new InsightsRollup(join(store.dir, config.mode === 'queue' ? `insights.${config.instanceId}.json` : 'insights.json'));
    process.once('exit', () => rollup.flush());
    return rollup;
  });
}

/** The hook store.saveExecution calls for every saved execution. Never throws: insights must not break a run. */
export function recordExecutionInsights(execution: RecordedExecution) {
  try {
    insightsRollup().record(execution);
  } catch {
    // A rollup that can't be written is not worth failing an execution for.
  }
}

/** Fill the rollup from the executions on disk, the first time only (bootstrap). */
export function backfillInsights(): number {
  return insightsRollup().backfill(store.listExecutions({ limit: Number.POSITIVE_INFINITY }));
}

/** The Insights page's report, with the current workflows' names and minutes saved per run. */
export function insightsReport(period: InsightsPeriod, includeManual = false, only?: Set<string>): InsightsReport {
  return insightsRollup().report({ period, includeManual, workflows: store.listWorkflows(), ...(only && { only }) });
}
