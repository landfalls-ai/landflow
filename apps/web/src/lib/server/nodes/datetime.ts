/**
 * Date & Time (n8n's `dateTime` v2). No date library: instants are epoch
 * milliseconds, time zones go through Intl.DateTimeFormat, and formats use
 * Luxon's tokens (what n8n users know): `yyyy-MM-dd HH:mm`, `'Week' W`, `X`…
 *
 * Calendar units (years, quarters, months, weeks, days) move the wall clock in
 * the chosen time zone, so "+1 day" across a DST change stays at the same local
 * time; time units (hours and smaller) are exact durations, as in Luxon.
 */
import { defineNode, NodeOperationError, type JsonObject, type NodeItem } from '@landflow/sdk';
import { instanceTimezone } from '../settings';
import { setPath } from './paths';

const main = [{ type: 'main' as const }];
const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      era: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

/** The instance's default zone (Settings → General; until set, GENERIC_TIMEZONE or the host's). */
export const defaultZone = () => instanceTimezone();

/** A valid IANA zone (or the instance default), else a NodeOperationError. */
export function resolveZone(zone: unknown): string {
  const name = String(zone ?? '').trim() || defaultZone();
  try {
    partsFormatter(name);
    return name;
  } catch {
    throw new NodeOperationError(`Unknown time zone “${name}”`, { description: 'Use an IANA name such as Europe/Berlin, America/New_York or UTC.' });
  }
}

/** The wall-clock time of an instant in a zone. */
export function wallClock(ms: number, zone: string): WallClock {
  const parts = partsFormatter(zone).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const bc = parts.find((p) => p.type === 'era')?.value === 'BC';
  return {
    year: bc ? 1 - get('year') : get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
    millisecond: ((ms % 1000) + 1000) % 1000,
  };
}

/** Wall-clock fields read as UTC (fields may overflow: day 32 is the next month). */
function wallAsUtc(w: WallClock): number {
  const date = new Date(0);
  date.setUTCFullYear(w.year, w.month - 1, w.day);
  date.setUTCHours(w.hour, w.minute, w.second, w.millisecond);
  return date.getTime();
}

const offsetAt = (ms: number, zone: string) => wallAsUtc(wallClock(ms, zone)) - ms;

/** The instant a wall-clock time denotes in a zone (Luxon's fixed-point algorithm: times in a gap move forward; an ambiguous time gets the offset Luxon would pick). */
export function fromWallClock(w: WallClock, zone: string): number {
  const local = wallAsUtc(w);
  const o1 = offsetAt(local, zone);
  let guess = local - o1;
  const o2 = offsetAt(guess, zone);
  if (o1 === o2) return guess;
  guess -= o2 - o1;
  const o3 = offsetAt(guess, zone);
  if (o2 === o3) return guess;
  return local - Math.min(o2, o3);
}

const pad = (n: number, width = 2) => (n < 0 ? '-' : '') + String(Math.abs(Math.trunc(n))).padStart(width, '0');

function offsetText(offsetMs: number, style: 'narrow' | 'short' | 'techie'): string {
  const minutes = Math.round(offsetMs / 60_000);
  const sign = minutes < 0 ? '-' : '+';
  const h = Math.floor(Math.abs(minutes) / 60);
  const m = Math.abs(minutes) % 60;
  if (style === 'narrow') return `${sign}${h}${m ? `:${pad(m)}` : ''}`;
  return style === 'short' ? `${sign}${pad(h)}:${pad(m)}` : `${sign}${pad(h)}${pad(m)}`;
}

const UTC_ZONES = new Set(['UTC', 'Etc/UTC', 'GMT', 'Etc/GMT', 'Z']);

/** ISO 8601 with the zone's offset, like Luxon's toISO(): 2026-10-25T14:03:00.000+02:00. */
export function toIso(ms: number, zone: string): string {
  const w = wallClock(ms, zone);
  const offset = wallAsUtc(w) - ms;
  const year = w.year >= 0 && w.year <= 9999 ? pad(w.year, 4) : (w.year < 0 ? '-' : '+') + pad(Math.abs(w.year), 6);
  const suffix = offset === 0 && UTC_ZONES.has(zone) ? 'Z' : offsetText(offset, 'short');
  return `${year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}.${pad(w.millisecond, 3)}${suffix}`;
}

// ---------------------------------------------------------------------------
// Calendar helpers
// ---------------------------------------------------------------------------

const isLeap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const daysInMonth = (year: number, month: number) => (month === 2 && isLeap(year) ? 29 : MONTH_DAYS[month - 1]);
const midnight = (w: WallClock) => wallAsUtc({ ...w, hour: 0, minute: 0, second: 0, millisecond: 0 });
/** 1 = Monday … 7 = Sunday. */
const weekdayOf = (w: WallClock) => new Date(midnight(w)).getUTCDay() || 7;

const dayOfYear = (w: WallClock) => Math.round((midnight(w) - midnight({ ...w, month: 1, day: 1 })) / DAY) + 1;

function isoWeek(w: WallClock): { week: number; weekYear: number } {
  const thursday = midnight(w) + (4 - weekdayOf(w)) * DAY;
  const weekYear = new Date(thursday).getUTCFullYear();
  const jan1 = midnight({ ...w, year: weekYear, month: 1, day: 1 });
  return { week: 1 + Math.floor((thursday - jan1) / DAY / 7), weekYear };
}

export type CalendarUnit = 'years' | 'quarters' | 'months' | 'weeks' | 'days' | 'hours' | 'minutes' | 'seconds' | 'milliseconds';

const EXACT_MS: Partial<Record<CalendarUnit, number>> = { hours: 3_600_000, minutes: 60_000, seconds: 1_000, milliseconds: 1 };

/** Add `amount` units: calendar units in the zone's wall clock (month ends clamp: Jan 31 + 1 month = Feb 28), time units exactly. */
export function addUnits(ms: number, zone: string, unit: CalendarUnit, amount: number): number {
  if (!Number.isFinite(amount)) throw new NodeOperationError(`“${amount}” is not a number`);
  const exact = EXACT_MS[unit];
  if (exact) return ms + amount * exact;
  const whole = Math.trunc(amount);
  const fraction = amount - whole;
  const w = wallClock(ms, zone);
  if (unit === 'days' || unit === 'weeks') {
    const days = unit === 'weeks' ? 7 : 1;
    return fromWallClock({ ...w, day: w.day + whole * days }, zone) + fraction * days * DAY;
  }
  if (fraction) throw new NodeOperationError(`Add whole ${unit}`, { description: `${amount} ${unit} is ambiguous; use days or a whole number.` });
  const months = w.month - 1 + whole * (unit === 'years' ? 12 : unit === 'quarters' ? 3 : 1);
  const year = w.year + Math.floor(months / 12);
  const month = (((months % 12) + 12) % 12) + 1;
  return fromWallClock({ ...w, year, month, day: Math.min(w.day, daysInMonth(year, month)) }, zone);
}

export type RoundUnit = 'year' | 'quarter' | 'month' | 'week' | 'day' | 'hour' | 'minute' | 'second';

/** Start of the unit containing the instant, in the zone (weeks start on Monday). */
export function startOf(ms: number, zone: string, unit: RoundUnit): number {
  const w = wallClock(ms, zone);
  const zeroTime = { hour: 0, minute: 0, second: 0, millisecond: 0 };
  switch (unit) {
    case 'year':
      return fromWallClock({ ...w, ...zeroTime, month: 1, day: 1 }, zone);
    case 'quarter':
      return fromWallClock({ ...w, ...zeroTime, month: Math.floor((w.month - 1) / 3) * 3 + 1, day: 1 }, zone);
    case 'month':
      return fromWallClock({ ...w, ...zeroTime, day: 1 }, zone);
    case 'week':
      return fromWallClock({ ...w, ...zeroTime, day: w.day - (weekdayOf(w) - 1) }, zone);
    case 'day':
      return fromWallClock({ ...w, ...zeroTime }, zone);
    case 'hour':
      return fromWallClock({ ...w, minute: 0, second: 0, millisecond: 0 }, zone);
    case 'minute':
      return fromWallClock({ ...w, second: 0, millisecond: 0 }, zone);
    default:
      return fromWallClock({ ...w, millisecond: 0 }, zone);
  }
}

const PLURAL: Record<RoundUnit, CalendarUnit> = {
  year: 'years',
  quarter: 'quarters',
  month: 'months',
  week: 'weeks',
  day: 'days',
  hour: 'hours',
  minute: 'minutes',
  second: 'seconds',
};

/** n8n's "round up": the start of the next unit. */
export const roundUp = (ms: number, zone: string, unit: RoundUnit) => startOf(addUnits(ms, zone, PLURAL[unit], 1), zone, unit);

// Casual unit lengths for the fractional remainder of a diff (Luxon's casual matrix).
const CASUAL_MS: Record<CalendarUnit, number> = {
  years: 365 * DAY,
  quarters: 91 * DAY,
  months: 30 * DAY,
  weeks: 7 * DAY,
  days: DAY,
  hours: 3_600_000,
  minutes: 60_000,
  seconds: 1_000,
  milliseconds: 1,
};
const UNIT_ORDER: CalendarUnit[] = ['years', 'quarters', 'months', 'weeks', 'days', 'hours', 'minutes', 'seconds', 'milliseconds'];

/**
 * Luxon-style diff in the given units: whole calendar units from the largest
 * down, the remainder as a fraction of the smallest unit. `{ months: 1, days: 2.5 }`.
 */
export function diff(startMs: number, endMs: number, zone: string, units: CalendarUnit[]): Record<string, number> {
  const selected = UNIT_ORDER.filter((unit) => units.includes(unit));
  if (!selected.length) selected.push('days');
  const sign = endMs >= startMs ? 1 : -1;
  const [from, to] = sign > 0 ? [startMs, endMs] : [endMs, startMs];
  const result: Record<string, number> = {};
  let cursor = from;
  for (const unit of selected) {
    let count = Math.floor((to - cursor) / CASUAL_MS[unit]);
    if (unit === 'months' || unit === 'quarters' || unit === 'years') {
      // Calendar months between the wall clocks, then fix up.
      const a = wallClock(cursor, zone);
      const b = wallClock(to, zone);
      const months = (b.year - a.year) * 12 + (b.month - a.month);
      count = Math.floor(months / (unit === 'years' ? 12 : unit === 'quarters' ? 3 : 1));
    }
    count = Math.max(0, count);
    while (count > 0 && addUnits(cursor, zone, unit, count) > to) count--;
    while (addUnits(cursor, zone, unit, count + 1) <= to) count++;
    result[unit] = count;
    cursor = addUnits(cursor, zone, unit, count);
  }
  const lowest = selected[selected.length - 1];
  if (to > cursor) result[lowest] += (to - cursor) / CASUAL_MS[lowest];
  for (const unit of selected) result[unit] = sign * result[unit] || 0;
  return result;
}

/** `{ months: 1, days: 2.5 }` → `P1M2.5D` (Luxon's Duration.toISO). */
export function durationToIso(duration: Record<string, number>): string {
  const months = (duration.months ?? 0) + (duration.quarters ?? 0) * 3;
  const seconds = (duration.seconds ?? 0) + (duration.milliseconds ?? 0) / 1000;
  const date = [
    [duration.years, 'Y'],
    [months, 'M'],
    [duration.weeks, 'W'],
    [duration.days, 'D'],
  ] as const;
  const time = [
    [duration.hours, 'H'],
    [duration.minutes, 'M'],
    [seconds, 'S'],
  ] as const;
  const part = (list: ReadonlyArray<readonly [number | undefined, string]>) =>
    list
      .filter(([n]) => n)
      .map(([n, s]) => `${Number((n as number).toFixed(9))}${s}`)
      .join('');
  const text = `P${part(date)}${part(time) ? `T${part(time)}` : ''}`;
  return text === 'P' ? 'PT0S' : text;
}

// ---------------------------------------------------------------------------
// Formatting (Luxon tokens)
// ---------------------------------------------------------------------------

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Longest token first within each letter, so `yyyy` wins over `yy`. Quoted text is literal; `''` is a quote. */
const TOKEN =
  /'(?:[^']|'')*'|yyyy|yy|y|MMMM|MMM|MM|M|LLLL|LLL|LL|L|dd|d|EEEE|EEE|E|cccc|ccc|c|HH|H|hh|h|mm|m|ss|s|SSS|S|a|ZZZZZ|ZZZZ|ZZZ|ZZ|Z|z|X|x|qq|q|kkkk|kk|WW|W|ooo|o|DDDD|DDD|DD|D|TT|T|t/g;

function zoneName(ms: number, zone: string, style: 'short' | 'long'): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: style }).formatToParts(new Date(ms));
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? zone;
}

interface FormatContext {
  ms: number;
  zone: string;
  w: WallClock;
  offset: number;
}

const hour12 = (c: FormatContext) => c.w.hour % 12 || 12;
const meridiem = (c: FormatContext) => (c.w.hour < 12 ? 'AM' : 'PM');
const monthName = (c: FormatContext) => MONTHS[c.w.month - 1];
const weekdayName = (c: FormatContext) => WEEKDAYS[weekdayOf(c.w) - 1];

const FORMAT_TOKENS: Record<string, (c: FormatContext) => string> = {
  yyyy: (c) => pad(c.w.year, 4),
  yy: (c) => pad(((c.w.year % 100) + 100) % 100),
  y: (c) => String(c.w.year),
  MMMM: monthName,
  MMM: (c) => monthName(c).slice(0, 3),
  MM: (c) => pad(c.w.month),
  M: (c) => String(c.w.month),
  dd: (c) => pad(c.w.day),
  d: (c) => String(c.w.day),
  EEEE: weekdayName,
  EEE: (c) => weekdayName(c).slice(0, 3),
  E: (c) => String(weekdayOf(c.w)),
  HH: (c) => pad(c.w.hour),
  H: (c) => String(c.w.hour),
  hh: (c) => pad(hour12(c)),
  h: (c) => String(hour12(c)),
  mm: (c) => pad(c.w.minute),
  m: (c) => String(c.w.minute),
  ss: (c) => pad(c.w.second),
  s: (c) => String(c.w.second),
  SSS: (c) => pad(c.w.millisecond, 3),
  S: (c) => String(c.w.millisecond),
  a: meridiem,
  Z: (c) => offsetText(c.offset, 'narrow'),
  ZZ: (c) => offsetText(c.offset, 'short'),
  ZZZ: (c) => offsetText(c.offset, 'techie'),
  ZZZZ: (c) => zoneName(c.ms, c.zone, 'short'),
  ZZZZZ: (c) => zoneName(c.ms, c.zone, 'long'),
  z: (c) => c.zone,
  X: (c) => String(Math.floor(c.ms / 1000)),
  x: (c) => String(c.ms),
  q: (c) => String(Math.ceil(c.w.month / 3)),
  qq: (c) => pad(Math.ceil(c.w.month / 3)),
  kkkk: (c) => pad(isoWeek(c.w).weekYear, 4),
  kk: (c) => pad(isoWeek(c.w).weekYear % 100),
  W: (c) => String(isoWeek(c.w).week),
  WW: (c) => pad(isoWeek(c.w).week),
  o: (c) => String(dayOfYear(c.w)),
  ooo: (c) => pad(dayOfYear(c.w), 3),
  D: (c) => `${c.w.month}/${c.w.day}/${c.w.year}`,
  DD: (c) => `${monthName(c).slice(0, 3)} ${c.w.day}, ${c.w.year}`,
  DDD: (c) => `${monthName(c)} ${c.w.day}, ${c.w.year}`,
  DDDD: (c) => `${weekdayName(c)}, ${monthName(c)} ${c.w.day}, ${c.w.year}`,
  t: (c) => `${hour12(c)}:${pad(c.w.minute)} ${meridiem(c)}`,
  T: (c) => `${pad(c.w.hour)}:${pad(c.w.minute)}`,
  TT: (c) => `${pad(c.w.hour)}:${pad(c.w.minute)}:${pad(c.w.second)}`,
};
// Stand-alone forms (L = month, c = weekday) format like their M / E counterparts.
for (const [alias, token] of [
  ['LLLL', 'MMMM'],
  ['LLL', 'MMM'],
  ['LL', 'MM'],
  ['L', 'M'],
  ['cccc', 'EEEE'],
  ['ccc', 'EEE'],
  ['c', 'E'],
])
  FORMAT_TOKENS[alias] = FORMAT_TOKENS[token];

export function formatDate(ms: number, zone: string, format: string): string {
  const w = wallClock(ms, zone);
  const context: FormatContext = { ms, zone, w, offset: wallAsUtc(w) - ms };
  return format.replace(TOKEN, (token) => (token.startsWith("'") ? token.slice(1, -1).replace(/''/g, "'") : FORMAT_TOKENS[token](context)));
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const ISO_DATE = /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

function parseOffset(text: string): number {
  if (/^z$/i.test(text)) return 0;
  const match = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(text)!;
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] ?? 0)) * 60_000;
}

const isDate = (value: unknown): value is Date => Object.prototype.toString.call(value) === '[object Date]';

/** Epoch milliseconds from a Date (any realm), epoch seconds/ms, an ISO string (local times are in `zone`) or anything Date.parse reads. */
export function toMillis(value: unknown, zone: string, fromFormat?: string): number {
  if (isDate(value)) {
    const ms = value.getTime();
    if (Number.isNaN(ms)) throw new NodeOperationError('Invalid date');
    return ms;
  }
  if (typeof value === 'number' || (typeof value === 'string' && /^-?\d{9,}(\.\d+)?$/.test(value.trim()))) {
    // Epoch seconds (10 digits until the year 2286) or milliseconds.
    const n = Number(value);
    return Math.abs(n) < 1e11 ? Math.round(n * 1000) : Math.round(n);
  }
  const text = String(value ?? '').trim();
  if (!text) throw new NodeOperationError('No date given', { description: 'The date parameter is empty. Map a date, e.g. {{ $json.createdAt }}.' });
  if (fromFormat) return parseWithFormat(text, fromFormat, zone);
  const iso = ISO_DATE.exec(text);
  if (iso) {
    const [, y, mo, d, h, mi, s, fraction, offset] = iso;
    const wall: WallClock = {
      year: Number(y),
      month: Number(mo),
      day: Number(d),
      hour: Number(h ?? 0),
      minute: Number(mi ?? 0),
      second: Number(s ?? 0),
      millisecond: fraction ? Math.round(Number(`0.${fraction}`) * 1000) : 0,
    };
    if (
      wall.month < 1 ||
      wall.month > 12 ||
      wall.day < 1 ||
      wall.day > daysInMonth(wall.year, wall.month) ||
      wall.hour > 24 ||
      wall.minute > 59 ||
      wall.second > 60
    ) {
      throw new NodeOperationError(`Invalid date “${text}”`);
    }
    return offset ? wallAsUtc(wall) - parseOffset(offset) : fromWallClock(wall, zone);
  }
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) {
    throw new NodeOperationError(`Invalid date “${text}”`, { description: 'Use ISO 8601 (2026-10-25T14:30:00), a timestamp, or set “From Date Format”.' });
  }
  return parsed;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const NAMES = (list: string[], short: boolean) => list.map((name) => (short ? name.slice(0, 3) : name)).join('|');

/** Parse with Luxon-style tokens: `dd/MM/yyyy HH:mm`. Missing fields default to January 1st, midnight. */
function parseWithFormat(text: string, format: string, zone: string): number {
  const fields: Array<(value: string, into: Record<string, number | string>) => void> = [];
  const capture = (pattern: string, apply: (value: string, into: Record<string, number | string>) => void) => {
    fields.push(apply);
    return `(${pattern})`;
  };
  const num = (key: string) => (value: string, into: Record<string, number | string>) => (into[key] = Number(value));
  const monthByName = (short: boolean) => (value: string, into: Record<string, number | string>) =>
    (into.month = MONTHS.findIndex((m) => (short ? m.slice(0, 3) : m).toLowerCase() === value.toLowerCase()) + 1);
  let source = '';
  let last = 0;
  for (const match of format.matchAll(TOKEN)) {
    source += escapeRegex(format.slice(last, match.index));
    last = match.index! + match[0].length;
    const t = match[0];
    if (t.startsWith("'")) source += escapeRegex(t.slice(1, -1).replace(/''/g, "'"));
    else if (t === 'yyyy') source += capture('\\d{4}', num('year'));
    else if (t === 'yy') source += capture('\\d{2}', (v, into) => (into.year = Number(v) + (Number(v) > 60 ? 1900 : 2000)));
    else if (t === 'y') source += capture('-?\\d{1,6}', num('year'));
    else if (t === 'MMMM' || t === 'LLLL') source += capture(NAMES(MONTHS, false), monthByName(false));
    else if (t === 'MMM' || t === 'LLL') source += capture(NAMES(MONTHS, true), monthByName(true));
    else if (t === 'MM' || t === 'LL' || t === 'dd' || t === 'HH' || t === 'hh' || t === 'mm' || t === 'ss') {
      source += capture('\\d{2}', num({ MM: 'month', LL: 'month', dd: 'day', HH: 'hour', hh: 'hour', mm: 'minute', ss: 'second' }[t]!));
    } else if (t === 'M' || t === 'L' || t === 'd' || t === 'H' || t === 'h' || t === 'm' || t === 's') {
      source += capture('\\d{1,2}', num({ M: 'month', L: 'month', d: 'day', H: 'hour', h: 'hour', m: 'minute', s: 'second' }[t]!));
    } else if (t === 'SSS') source += capture('\\d{3}', num('millisecond'));
    else if (t === 'S') source += capture('\\d{1,3}', num('millisecond'));
    else if (t === 'a') source += capture('AM|PM', (v, into) => (into.meridiem = v.toUpperCase()));
    else if (t === 'EEEE' || t === 'cccc') source += capture(NAMES(WEEKDAYS, false), () => undefined);
    else if (t === 'EEE' || t === 'ccc') source += capture(NAMES(WEEKDAYS, true), () => undefined);
    else if (t === 'Z' || t === 'ZZ' || t === 'ZZZ') source += capture('Z|[+-]\\d{1,2}(?::?\\d{2})?', (v, into) => (into.offset = parseOffset(v)));
    else if (t === 'z') source += capture('[A-Za-z_]+(?:/[A-Za-z0-9_+-]+)*', (v, into) => (into.zone = v));
    else if (t === 'X') source += capture('-?\\d+(?:\\.\\d+)?', (v, into) => (into.epoch = Number(v) * 1000));
    else if (t === 'x') source += capture('-?\\d+', (v, into) => (into.epoch = Number(v)));
    else
      throw new NodeOperationError(`“${t}” can't be used in From Date Format`, {
        description: 'Supported: y, M, d, H, h, m, s, S, a, E, Z, z, X, x and quoted text.',
      });
  }
  source += escapeRegex(format.slice(last));
  const match = new RegExp(`^${source}$`, 'i').exec(text);
  if (!match) throw new NodeOperationError(`“${text}” doesn't match the format “${format}”`);
  const into: Record<string, number | string> = {};
  fields.forEach((apply, index) => apply(match[index + 1], into));
  if (typeof into.epoch === 'number') return into.epoch;
  let hour = Number(into.hour ?? 0);
  if (into.meridiem === 'PM' && hour < 12) hour += 12;
  if (into.meridiem === 'AM' && hour === 12) hour = 0;
  const wall: WallClock = {
    year: Number(into.year ?? new Date().getUTCFullYear()),
    month: Number(into.month ?? 1),
    day: Number(into.day ?? 1),
    hour,
    minute: Number(into.minute ?? 0),
    second: Number(into.second ?? 0),
    millisecond: Number(into.millisecond ?? 0),
  };
  if (typeof into.offset === 'number') return wallAsUtc(wall) - into.offset;
  return fromWallClock(wall, typeof into.zone === 'string' ? resolveZone(into.zone) : zone);
}

// ---------------------------------------------------------------------------
// The node
// ---------------------------------------------------------------------------

const ADD_UNITS = UNIT_ORDER.map((unit) => ({ name: unit[0].toUpperCase() + unit.slice(1), value: unit }));
const ROUND_UNITS: Array<{ name: string; value: RoundUnit }> = [
  { name: 'Year', value: 'year' },
  { name: 'Quarter', value: 'quarter' },
  { name: 'Month', value: 'month' },
  { name: 'Week', value: 'week' },
  { name: 'Day', value: 'day' },
  { name: 'Hour', value: 'hour' },
  { name: 'Minute', value: 'minute' },
  { name: 'Second', value: 'second' },
];
const EXTRACT: Record<string, (w: WallClock) => number> = {
  year: (w) => w.year,
  quarter: (w) => Math.ceil(w.month / 3),
  month: (w) => w.month,
  week: (w) => isoWeek(w).week,
  day: (w) => w.day,
  weekday: weekdayOf,
  dayOfYear,
  hour: (w) => w.hour,
  minute: (w) => w.minute,
  second: (w) => w.second,
};
const PARTS: Array<{ name: string; value: string }> = [
  { name: 'Year', value: 'year' },
  { name: 'Quarter', value: 'quarter' },
  { name: 'Month', value: 'month' },
  { name: 'Week (ISO)', value: 'week' },
  { name: 'Day', value: 'day' },
  { name: 'Day of Week (1 = Monday)', value: 'weekday' },
  { name: 'Day of Year', value: 'dayOfYear' },
  { name: 'Hour', value: 'hour' },
  { name: 'Minute', value: 'minute' },
  { name: 'Second', value: 'second' },
];

const DEFAULT_FIELD: Record<string, string> = {
  getCurrentDate: 'currentDate',
  addToDate: 'newDate',
  subtractFromDate: 'newDate',
  formatDate: 'formattedDate',
  getTimeBetweenDates: 'timeDifference',
  extractDate: 'datePart',
  roundDate: 'roundedDate',
};

const op = (...operations: string[]) => ({ show: { operation: operations } });

export const dateTimeNode = defineNode({
  description: {
    name: 'dateTime',
    displayName: 'Date & Time',
    description: 'Get, shift, format, compare, round or pick apart dates, in any time zone',
    version: 1,
    kind: 'action',
    categories: ['Data'],
    icon: 'lucide:calendar-clock',
    color: '#14b8a6',
    subtitle: '{{operation}}',
    keywords: ['date', 'time', 'timezone', 'format', 'duration', 'add', 'subtract', 'round', 'now', 'timestamp'],
    inputs: main,
    outputs: main,
    properties: [
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        default: 'getCurrentDate',
        noDataExpression: true,
        options: [
          { name: 'Add to a Date', value: 'addToDate', action: 'Add to a date' },
          { name: 'Extract Part of a Date', value: 'extractDate', action: 'Extract part of a date' },
          { name: 'Format a Date', value: 'formatDate', action: 'Format a date' },
          { name: 'Get Current Date', value: 'getCurrentDate', action: 'Get current date' },
          { name: 'Get Time Between Dates', value: 'getTimeBetweenDates', action: 'Get time between dates' },
          { name: 'Round a Date', value: 'roundDate', action: 'Round a date' },
          { name: 'Subtract From a Date', value: 'subtractFromDate', action: 'Subtract from a date' },
        ],
      },
      {
        name: 'includeTime',
        displayName: 'Include Current Time',
        type: 'boolean',
        default: true,
        description: 'Off: midnight today',
        displayOptions: op('getCurrentDate'),
      },
      {
        name: 'magnitude',
        displayName: 'Date',
        type: 'string',
        default: '',
        required: true,
        placeholder: '{{ $json.date }}',
        displayOptions: op('addToDate', 'subtractFromDate'),
      },
      { name: 'timeUnit', displayName: 'Time Unit', type: 'options', default: 'days', options: ADD_UNITS, displayOptions: op('addToDate', 'subtractFromDate') },
      { name: 'duration', displayName: 'Duration', type: 'number', default: 0, displayOptions: op('addToDate', 'subtractFromDate') },
      {
        name: 'date',
        displayName: 'Date',
        type: 'string',
        default: '',
        required: true,
        placeholder: '{{ $json.date }}',
        displayOptions: op('formatDate', 'extractDate', 'roundDate'),
      },
      {
        name: 'format',
        displayName: 'Format',
        type: 'options',
        default: 'MM/dd/yyyy',
        displayOptions: op('formatDate'),
        options: [
          { name: 'MM/DD/YYYY', value: 'MM/dd/yyyy', description: 'Example: 09/04/1986' },
          { name: 'YYYY/MM/DD', value: 'yyyy/MM/dd', description: 'Example: 1986/04/09' },
          { name: 'MMMM DD YYYY', value: 'MMMM dd yyyy', description: 'Example: April 09 1986' },
          { name: 'MM-DD-YYYY', value: 'MM-dd-yyyy', description: 'Example: 09-04-1986' },
          { name: 'YYYY-MM-DD', value: 'yyyy-MM-dd', description: 'Example: 1986-04-09' },
          { name: 'ISO 8601', value: 'iso', description: 'Example: 1986-04-09T14:30:00.000+02:00' },
          { name: 'Unix Timestamp', value: 'X', description: 'Seconds. Example: 513388800' },
          { name: 'Unix Ms Timestamp', value: 'x', description: 'Milliseconds. Example: 513388800000' },
          { name: 'Custom Format', value: 'custom' },
        ],
      },
      {
        name: 'customFormat',
        displayName: 'Custom Format',
        type: 'string',
        default: "yyyy-MM-dd'T'HH:mm",
        displayOptions: { show: { operation: ['formatDate'], format: ['custom'] } },
        hint: "Luxon tokens: yyyy MM dd HH mm ss SSS, MMM/MMMM month names, EEE/EEEE weekdays, a AM/PM, ZZ offset, z zone, W week, q quarter. Quote literal text: 'at'.",
      },
      {
        name: 'startDate',
        displayName: 'Start Date',
        type: 'string',
        default: '',
        required: true,
        placeholder: '{{ $json.start }}',
        displayOptions: op('getTimeBetweenDates'),
      },
      {
        name: 'endDate',
        displayName: 'End Date',
        type: 'string',
        default: '',
        required: true,
        placeholder: '{{ $now }}',
        displayOptions: op('getTimeBetweenDates'),
      },
      {
        name: 'units',
        displayName: 'Units',
        type: 'multiOptions',
        default: ['day'],
        displayOptions: op('getTimeBetweenDates'),
        options: ['year', 'month', 'week', 'day', 'hour', 'minute', 'second', 'millisecond'].map((unit) => ({
          name: unit[0].toUpperCase() + unit.slice(1),
          value: unit,
        })),
      },
      {
        name: 'part',
        displayName: 'Part',
        type: 'options',
        default: 'month',
        displayOptions: op('extractDate'),
        options: PARTS,
      },
      {
        name: 'mode',
        displayName: 'Mode',
        type: 'options',
        default: 'roundDown',
        displayOptions: op('roundDate'),
        options: [
          { name: 'Round Down', value: 'roundDown', description: 'To the start of the unit' },
          { name: 'Round Up', value: 'roundUp', description: 'To the start of the next unit' },
        ],
      },
      { name: 'toNearest', displayName: 'To Nearest', type: 'options', default: 'day', options: ROUND_UNITS, displayOptions: op('roundDate') },
      {
        name: 'outputFieldName',
        displayName: 'Output Field Name',
        type: 'string',
        default: '',
        noDataExpression: true,
        placeholder: 'newDate',
        hint: 'Empty: currentDate, newDate, formattedDate, timeDifference, datePart or roundedDate, by operation.',
      },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          {
            name: 'timezone',
            displayName: 'Timezone',
            type: 'string',
            default: '',
            placeholder: 'Europe/Berlin',
            description: 'IANA time zone for reading, shifting and writing dates. Default: the instance’s (Settings → General).',
          },
          {
            name: 'fromFormat',
            displayName: 'From Date Format',
            type: 'string',
            default: '',
            placeholder: 'dd/MM/yyyy HH:mm',
            description: 'How the input dates are written, when they are not ISO 8601 or a timestamp',
          },
          {
            name: 'isoString',
            displayName: 'Output as ISO String',
            type: 'boolean',
            default: false,
            description: 'Time between dates: an ISO 8601 duration such as P1DT2H',
          },
        ],
      },
    ],
  },
  execute(ctx) {
    const out: NodeItem[] = [];
    ctx.getInputData().forEach((item, i) => {
      const operation = ctx.getNodeParameter<string>('operation', i);
      const options = ctx.getNodeParameter<{ timezone?: string; fromFormat?: string; isoString?: boolean }>('options', i) ?? {};
      const zone = resolveZone(options.timezone);
      const read = (name: string) => toMillis(ctx.getNodeParameter(name, i), zone, options.fromFormat?.trim() || undefined);
      let value: unknown;
      try {
        switch (operation) {
          case 'getCurrentDate':
            value = toIso(ctx.getNodeParameter<boolean>('includeTime', i) ? Date.now() : startOf(Date.now(), zone, 'day'), zone);
            break;
          case 'addToDate':
          case 'subtractFromDate': {
            const amount = Number(ctx.getNodeParameter('duration', i));
            const unit = ctx.getNodeParameter<CalendarUnit>('timeUnit', i);
            value = toIso(addUnits(read('magnitude'), zone, unit, operation === 'addToDate' ? amount : -amount), zone);
            break;
          }
          case 'formatDate': {
            const preset = ctx.getNodeParameter<string>('format', i);
            const ms = read('date');
            value =
              preset === 'iso' ? toIso(ms, zone) : formatDate(ms, zone, preset === 'custom' ? String(ctx.getNodeParameter('customFormat', i) ?? '') : preset);
            break;
          }
          case 'getTimeBetweenDates': {
            const units = (ctx.getNodeParameter<string[]>('units', i) ?? ['day']).map((unit) => `${unit}s` as CalendarUnit);
            const duration = diff(read('startDate'), read('endDate'), zone, units);
            value = options.isoString ? durationToIso(duration) : duration;
            break;
          }
          case 'extractDate': {
            const ms = read('date');
            const w = wallClock(ms, zone);
            const extract = EXTRACT[ctx.getNodeParameter<string>('part', i)];
            if (!extract) throw new NodeOperationError(`Unknown part "${String(ctx.getNodeParameter('part', i))}"`);
            value = extract(w);
            break;
          }
          case 'roundDate': {
            const unit = ctx.getNodeParameter<RoundUnit>('toNearest', i);
            const ms = read('date');
            value = toIso(ctx.getNodeParameter('mode', i) === 'roundUp' ? roundUp(ms, zone, unit) : startOf(ms, zone, unit), zone);
            break;
          }
          default:
            throw new NodeOperationError(`Unknown operation "${operation}"`);
        }
      } catch (error) {
        if (error instanceof NodeOperationError && error.itemIndex === undefined) {
          throw new NodeOperationError(error.message, { itemIndex: i, ...(error.description && { description: error.description }) });
        }
        throw error;
      }
      const json = structuredClone(item.json) as Record<string, unknown>;
      setPath(json, String(ctx.getNodeParameter('outputFieldName', i) ?? '').trim() || DEFAULT_FIELD[operation], value);
      out.push({ json: json as JsonObject, pairedItem: { item: i } });
    });
    return [out];
  },
});
