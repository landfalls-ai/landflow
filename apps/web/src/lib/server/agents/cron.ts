/**
 * Agent schedules: hourly / daily / weekly / monthly map onto a five-field cron
 * (minute hour day-of-month month day-of-week), checked once per minute in the
 * schedule's time zone. Supports `*`, lists, ranges, steps and month / weekday
 * names. The Schedule trigger (lib/server/scheduler.ts) also uses six fields,
 * with seconds first, and checks every second.
 */
import type { AgentSchedule } from '../../shared/agents';

const SECONDS = { min: 0, max: 59 };
const FIELDS = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // day of week (0 = Sunday; 7 is accepted as Sunday)
];

function parseField(field: string, { min, max }: { min: number; max: number }): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid step in "${part}"`);
    let [from, to] = [min, max];
    if (range !== '*') {
      const [a, b] = range.split('-').map(Number);
      if (!Number.isInteger(a) || (b !== undefined && !Number.isInteger(b))) throw new Error(`Invalid value "${part}"`);
      from = a;
      to = b ?? (stepText === undefined ? a : max);
    }
    const top = max === 6 ? 7 : max;
    if (from < min || to > top || from > to) throw new Error(`"${part}" is out of range ${min}-${max}`);
    for (let v = from; v <= to; v += step) values.add(max === 6 && v === 7 ? 0 : v);
  }
  return values;
}

export interface CronMatcher {
  /** Five fields: any second of a matching minute; six: only the matching seconds. */
  matches(parts: TimeParts): boolean;
  /** Whether the expression has a seconds field. */
  readonly seconds: boolean;
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** "jan-mar" → "1-3", "mon,fri" → "1,5". */
const replaceNames = (field: string, names: string[], offset: number) =>
  field.replace(/[a-z]{3}/gi, (name) => {
    const index = names.indexOf(name.toLowerCase());
    if (index < 0) throw new Error(`Unknown name "${name}"`);
    return String(index + offset);
  });

export function parseCron(expression: string): CronMatcher {
  let fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) throw new Error('A cron expression has five fields: minute hour day-of-month month day-of-week (or six, with seconds first)');
  const secondField = fields.length === 6 ? fields[0] : undefined;
  if (secondField !== undefined) fields = fields.slice(1);
  // Quartz-style "?" (no specific value) in the day fields means "*".
  fields = fields.map((field, i) => (field === '?' && (i === 2 || i === 4) ? '*' : field));
  fields[3] = replaceNames(fields[3], MONTH_NAMES, 1);
  fields[4] = replaceNames(fields[4], DAY_NAMES, 0);
  const seconds = secondField === undefined ? undefined : parseField(secondField, SECONDS);
  const [minutes, hours, days, months, weekdays] = fields.map((field, i) => parseField(field, FIELDS[i]));
  const anyDay = fields[2] === '*';
  const anyWeekday = fields[4] === '*';
  return {
    seconds: seconds !== undefined,
    matches: (t) =>
      (seconds === undefined || seconds.has(t.second ?? 0)) &&
      minutes.has(t.minute) &&
      hours.has(t.hour) &&
      months.has(t.month) &&
      // Classic cron: when both day fields are restricted, either one matching is enough.
      (anyDay || anyWeekday ? days.has(t.day) && weekdays.has(t.weekday) : days.has(t.day) || weekdays.has(t.weekday)),
  };
}

const hhmm = (time: string | undefined) => {
  const text = (time ?? '09:00').trim();
  // Hourly schedules may store just the minute ("15").
  const [h, m] = (text.includes(':') ? text : `0:${text}`).split(':').map(Number);
  return { hour: Number.isInteger(h) ? Math.min(23, Math.max(0, h)) : 9, minute: Number.isInteger(m) ? Math.min(59, Math.max(0, m)) : 0 };
};

/** The cron a schedule runs on. */
export function scheduleCron(schedule: Pick<AgentSchedule, 'frequency' | 'time' | 'weekday' | 'dayOfMonth' | 'cron'>): string {
  const { hour, minute } = hhmm(schedule.time);
  switch (schedule.frequency) {
    case 'hourly':
      return `${minute} * * * *`;
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekly':
      return `${minute} ${hour} * * ${schedule.weekday ?? 1}`;
    case 'monthly':
      return `${minute} ${hour} ${Math.min(28, Math.max(1, schedule.dayOfMonth ?? 1))} * *`;
    case 'cron':
      return schedule.cron?.trim() || '0 9 * * *';
  }
}

export interface TimeParts {
  /** Set by timeParts(); the Schedule trigger's rules and six-field crons use it. */
  second?: number;
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
  year?: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const formats = new Map<string, Intl.DateTimeFormat>();

/** A cached formatter per zone (the Schedule trigger asks every second). */
function formatFor(timeZone: string): Intl.DateTimeFormat {
  let format = formats.get(timeZone);
  if (!format) {
    const options: Intl.DateTimeFormatOptions = { hourCycle: 'h23', weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' };
    try {
      format = new Intl.DateTimeFormat('en-US', { ...options, timeZone });
    } catch {
      format = new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' });
    }
    formats.set(timeZone, format);
  }
  return format;
}

/** Wall-clock fields of an instant in a time zone (UTC when the zone is unknown). */
export function timeParts(at: Date, timeZone: string): TimeParts {
  const parts = Object.fromEntries(formatFor(timeZone).formatToParts(at).map((p) => [p.type, p.value]));
  return {
    second: Number(parts.second) % 60,
    minute: Number(parts.minute),
    hour: Number(parts.hour) % 24,
    day: Number(parts.day),
    month: Number(parts.month),
    weekday: WEEKDAYS[parts.weekday] ?? 0,
    year: Number(parts.year),
  };
}

/** Whether a schedule fires in the minute of `at` (checked once a minute, so a seconds field counts as second 0). */
export function isDue(schedule: AgentSchedule, at: Date): boolean {
  return parseCron(scheduleCron(schedule)).matches({ ...timeParts(at, schedule.timezone || 'UTC'), second: 0 });
}
