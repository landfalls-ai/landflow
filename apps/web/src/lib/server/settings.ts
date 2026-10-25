/**
 * Instance settings (Settings → General): the default time zone and execution
 * retention, in the `settings` table (lib/server/db). The row is small and read
 * on every call, so every module graph (and a hot reload) sees the same values;
 * writes are validated with zod. SettingsFile keeps the same document in a JSON
 * file (the format older versions used; tests use it too).
 *
 * Retention: store.saveExecution prunes after every save, bootstrap prunes at
 * boot and hourly, and Settings has "Prune now". Only finished executions
 * (success, error, canceled) are ever removed; running and waiting ones stay.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { InstanceSettings, RetentionSettings } from '../shared/platform';
import type { ExecutionSummary } from '../shared/types';
import { database, type Database } from './db';
import { INSTANCE_SETTINGS } from './db/rows';
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
export const instanceSettingsSchema = z.object({ timezone: timezoneSchema, executions: retentionSchema });

/** PATCH /api/settings: any subset; `executions` merges field by field. */
export const settingsPatchSchema = z.strictObject({
  timezone: timezoneSchema.optional(),
  executions: retentionSchema.partial().strict().optional(),
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
    timezone: timezone.success ? timezone.data : defaults.timezone,
    executions: {
      maxCount: maxCount.success ? maxCount.data : defaults.executions.maxCount,
      maxAgeDays: maxAgeDays.success ? maxAgeDays.data : defaults.executions.maxAgeDays,
    },
  };
}

function merged(current: InstanceSettings, patch: SettingsPatch): InstanceSettings {
  return instanceSettingsSchema.parse({ timezone: patch.timezone ?? current.timezone, executions: { ...current.executions, ...patch.executions } });
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

/** Delete the executions the retention settings (or `policy`) no longer keep. Returns how many were removed. */
export function pruneExecutions(policy: RetentionSettings = getSettings().executions, now = Date.now()): number {
  const stale = staleExecutionIds(store.listExecutions({ limit: Number.POSITIVE_INFINITY }), policy, now);
  for (const id of stale) store.deleteExecution(id);
  return stale.length;
}
