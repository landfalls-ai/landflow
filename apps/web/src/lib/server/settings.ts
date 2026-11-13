/**
 * Instance settings (Settings → General): the default time zone and execution
 * retention, in the `settings` table (lib/server/db). The row is small and read
 * on every call, so every module graph (and a hot reload) sees the same values;
 * writes are validated with zod. SettingsFile keeps the same document in a JSON
 * file (the format older versions used; tests use it too).
 *
 * Retention: execution-reactions.ts prunes (retentionTick) every LANDFLOW_RETENTION_EVERY
 * finished saves, the leader prunes at boot and hourly, and
 * Settings has "Prune now". Only finished executions (success, error,
 * canceled) are ever removed; running and waiting ones stay.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { InstanceSettings, RetentionSettings } from '../shared/platform';
import type { ExecutionSummary } from '../shared/types';
import { jsonRenderEnabled } from '../shared/ui-spec';
import { envInt } from './config';
import { database, type Database } from './db';
import { INSTANCE_SETTINGS } from './db/rows';
import { singleton } from './singleton';
import { atomicWrite, store } from './store';

export type { InstanceSettings, RetentionSettings };

/** The execution cap Landflow had before retention became a setting. */
export const DEFAULT_MAX_EXECUTIONS = 300;

const DAY_MS = 86_400_000;
/** Statuses retention may delete. Anything else (running, waiting, …) is kept. */
const FINISHED = new Set(['success', 'error', 'canceled']);

/** The host's zone, or n8n's GENERIC_TIMEZONE when set: the default until Settings says otherwise. */
export function hostTimeZone(): string {
  const configured = process.env.GENERIC_TIMEZONE?.trim();
  if (configured && isTimeZone(configured)) return configured;
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** True for a zone Intl knows (IANA names such as "Europe/Berlin", or "UTC"). */
export function isTimeZone(value: string): boolean {
  if (!value) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const timezoneSchema = z.string().max(64).refine(isTimeZone, 'Unknown time zone');
const retentionSchema = z.object({
  maxCount: z.number().int().min(0).max(1_000_000),
  maxAgeDays: z.number().int().min(0).max(3650),
});

/** A complete, valid settings document. */
export const instanceSettingsSchema = z.object({ timezone: timezoneSchema, executions: retentionSchema, jsonRender: z.boolean().optional() });

/** PATCH /api/settings: any subset; `executions` merges field by field. */
export const settingsPatchSchema = z.strictObject({
  timezone: timezoneSchema.optional(),
  executions: retentionSchema.partial().strict().optional(),
  /** true/false saves the choice; null goes back to the environment default. */
  jsonRender: z.boolean().nullable().optional(),
});
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export function defaultSettings(): InstanceSettings {
  return { timezone: hostTimeZone(), executions: { maxCount: DEFAULT_MAX_EXECUTIONS, maxAgeDays: 0 } };
}

/** Saved values over the defaults; a saved value that is no longer valid (an unknown zone) falls back to its default. */
function withDefaults(saved: Partial<InstanceSettings>): InstanceSettings {
  const defaults = defaultSettings();
  const timezone = timezoneSchema.safeParse(saved.timezone);
  const maxCount = retentionSchema.shape.maxCount.safeParse(saved.executions?.maxCount);
  const maxAgeDays = retentionSchema.shape.maxAgeDays.safeParse(saved.executions?.maxAgeDays);
  return {
    ...(typeof saved.jsonRender === 'boolean' ? { jsonRender: saved.jsonRender } : {}),
    timezone: timezone.success ? timezone.data : defaults.timezone,
    executions: {
      maxCount: maxCount.success ? maxCount.data : defaults.executions.maxCount,
      maxAgeDays: maxAgeDays.success ? maxAgeDays.data : defaults.executions.maxAgeDays,
    },
  };
}

function merged(current: InstanceSettings, patch: SettingsPatch): InstanceSettings {
  const jsonRender = patch.jsonRender === undefined ? current.jsonRender : (patch.jsonRender ?? undefined);
  return instanceSettingsSchema.parse({ timezone: patch.timezone ?? current.timezone, executions: { ...current.executions, ...patch.executions }, ...(jsonRender === undefined ? {} : { jsonRender }) });
}

/** Settings backed by one JSON file. */
export class SettingsFile {
  constructor(readonly path: string) {}

  get(): InstanceSettings {
    let saved: Partial<InstanceSettings> = {};
    try {
      saved = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<InstanceSettings>;
    } catch {
      // No settings saved yet.
    }
    return withDefaults(saved ?? {});
  }

  update(patch: SettingsPatch): InstanceSettings {
    const next = merged(this.get(), patch);
    atomicWrite(this.path, next);
    return next;
  }
}

/** Settings in the database's `settings` table: the instance's. */
export class SettingsTable {
  constructor(private readonly db: () => Database = database) {}

  get(): InstanceSettings {
    let saved: Partial<InstanceSettings> = {};
    try {
      saved = JSON.parse(this.db().get<{ value: string }>('SELECT value FROM settings WHERE key = ?', INSTANCE_SETTINGS)?.value ?? '{}') as Partial<InstanceSettings>;
    } catch {
      // Unreadable: the defaults.
    }
    return withDefaults(saved ?? {});
  }

  update(patch: SettingsPatch): InstanceSettings {
    const next = merged(this.get(), patch);
    this.db().upsert('settings', { key: INSTANCE_SETTINGS, value: JSON.stringify(next) });
    return next;
  }
}

const instance = new SettingsTable();

export function getSettings(): InstanceSettings {
  return instance.get();
}

export function updateSettings(patch: SettingsPatch): InstanceSettings {
  return instance.update(patch);
}

/** Whether the json-render prototype is on: the saved setting, else the environment default. */
export function jsonRenderOn(): boolean {
  return jsonRenderEnabled(getSettings().jsonRender);
}

/** The instance's default time zone (Settings → General). */
export function instanceTimezone(): string {
  return getSettings().timezone;
}

/**
 * Ids of the executions a retention policy removes. `executions` is newest
 * first (as the store keeps them); the newest `maxCount` finished runs are kept
 * and finished runs older than `maxAgeDays` go. Running and waiting runs are
 * never returned and don't count towards `maxCount`.
 */
export function staleExecutionIds(executions: Array<Pick<ExecutionSummary, 'id' | 'status' | 'startedAt'>>, policy: RetentionSettings, now = Date.now()): string[] {
  const cutoff = policy.maxAgeDays > 0 ? now - policy.maxAgeDays * DAY_MS : -Infinity;
  const stale: string[] = [];
  let kept = 0;
  for (const execution of executions) {
    if (!FINISHED.has(execution.status)) continue;
    const started = Date.parse(execution.startedAt);
    if (started < cutoff || (policy.maxCount > 0 && kept >= policy.maxCount)) stale.push(execution.id);
    else kept++;
  }
  return stale;
}

const PRUNE_CHUNK = 1000;
const FINISHED_LIST = [...FINISHED];
const FINISHED_SQL = FINISHED_LIST.map(() => '?').join(', ');

/**
 * Delete the executions the retention settings (or `policy`) no longer keep. Returns how many were removed.
 * Works in SQL on columns only (never parses a summary), in chunks, so the cost does not grow with the history;
 * it selects the same ids as staleExecutionIds. Age goes first: those are the oldest, so the count pass then
 * sees only runs inside the age window, as staleExecutionIds does.
 */
export function pruneExecutions(policy: RetentionSettings = getSettings().executions, now = Date.now()): number {
  const db = database();
  let removed = 0;
  const drain = (sql: string, ...params: Array<string | number>) => {
    for (;;) {
      const rows = db.all<{ id: string }>(sql, ...params);
      let deleted = 0;
      for (const row of rows) if (store.deleteExecution(row.id)) deleted++;
      removed += deleted;
      // A full chunk that deleted nothing would select the same rows again: stop rather than spin.
      if (rows.length < PRUNE_CHUNK || deleted === 0) return;
    }
  };
  if (policy.maxAgeDays > 0) {
    const cutoff = new Date(now - policy.maxAgeDays * DAY_MS).toISOString();
    drain(`SELECT id FROM executions WHERE status IN (${FINISHED_SQL}) AND started_at < ? ORDER BY started_at LIMIT ${PRUNE_CHUNK}`, ...FINISHED_LIST, cutoff);
  }
  if (policy.maxCount > 0) {
    drain(`SELECT id FROM executions WHERE status IN (${FINISHED_SQL}) ORDER BY started_at DESC, id DESC LIMIT ${PRUNE_CHUNK} OFFSET ?`, ...FINISHED_LIST, policy.maxCount);
  }
  return removed;
}

/**
 * How many executions are stored and how many the retention settings (or `policy`) would remove now, counted in SQL
 * the way pruneExecutions selects them (Settings → General shows both), without reading a summary.
 */
export function retentionCounts(policy: RetentionSettings = getSettings().executions, now = Date.now()): { stored: number; prunable: number } {
  const db = database();
  const count = (sql: string, ...params: Array<string | number>) => Number(db.get<{ n: number }>(sql, ...params)?.n ?? 0);
  const stored = count("SELECT COUNT(*) AS n FROM executions WHERE status <> 'running'");
  const cutoff = policy.maxAgeDays > 0 ? new Date(now - policy.maxAgeDays * DAY_MS).toISOString() : undefined;
  const aged = cutoff ? count(`SELECT COUNT(*) AS n FROM executions WHERE status IN (${FINISHED_SQL}) AND started_at < ?`, ...FINISHED_LIST, cutoff) : 0;
  const finished = count(`SELECT COUNT(*) AS n FROM executions WHERE status IN (${FINISHED_SQL})`, ...FINISHED_LIST);
  const overCap = policy.maxCount > 0 ? Math.max(0, finished - aged - policy.maxCount) : 0;
  return { stored, prunable: aged + overCap };
}

const retention = singleton('retention-tick', () => ({ finished: 0 }));

/** Tests: start counting finished saves from zero. */
export function resetRetentionTick(): void {
  retention.finished = 0;
}

/**
 * Called by every finished save: runs a prune pass every LANDFLOW_RETENTION_EVERY finished runs (default 50,
 * minimum 1), so the count may exceed its cap by up to N-1 between passes. The hourly timer and "Prune now" prune
 * regardless.
 */
export function retentionTick(): number {
  const every = envInt('LANDFLOW_RETENTION_EVERY', { fallback: 50, min: 1 });
  if (++retention.finished < every) return 0;
  retention.finished = 0;
  return pruneExecutions();
}
