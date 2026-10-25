/**
 * Agent schedules: hourly / daily / weekly / monthly map onto a five-field cron
 * (minute hour day-of-month month day-of-week), checked once per minute in the
 * schedule's time zone. Supports `*`, lists, ranges and steps.
 */
import type { AgentSchedule } from '../../shared/agents';

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
  matches(parts: TimeParts): boolean;
}

export function parseCron(expression: string): CronMatcher {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('A cron expression has five fields: minute hour day-of-month month day-of-week');
  const [minutes, hours, days, months, weekdays] = fields.map((field, i) => parseField(field, FIELDS[i]));
  const anyDay = fields[2] === '*';
  const anyWeekday = fields[4] === '*';
  return {
    matches: (t) =>
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
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock fields of an instant in a time zone (UTC when the zone is unknown). */
export function timeParts(at: Date, timeZone: string): TimeParts {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
  } catch {
    format = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hourCycle: 'h23', weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
  }
  const parts = Object.fromEntries(format.formatToParts(at).map((p) => [p.type, p.value]));
  return { minute: Number(parts.minute), hour: Number(parts.hour) % 24, day: Number(parts.day), month: Number(parts.month), weekday: WEEKDAYS[parts.weekday] ?? 0 };
}

/** Whether a schedule fires in the minute of `at`. */
export function isDue(schedule: AgentSchedule, at: Date): boolean {
  return parseCron(scheduleCron(schedule)).matches(timeParts(at, schedule.timezone || 'UTC'));
}
