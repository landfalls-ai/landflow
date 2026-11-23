/**
 * Relative dates for Memory Extract (docs/second-brain.md#memory-extract, C28 FR-2): a fixed list of English phrases
 * resolved against the date a text was written, in UTC calendar days. The list is the model's safety net (C28-D4): it
 * overrides the model's own answer for the phrases it knows, and anything the model resolves itself is only kept when it
 * is a real date within ten years of the reference. Pure: no clock is read here, the reference is always passed in.
 */

export interface ResolvedTime {
  iso?: string;
  range?: { from: string; to: string };
  unresolved?: true;
}

const DAY_MS = 86_400_000;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const TEN_YEARS_MS = 10 * 365.25 * DAY_MS;

/** UTC midnight of the reference's calendar day. */
const startOfDay = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS);
const fmt = (date: Date) => date.toISOString().slice(0, 10);
const day = (date: Date): ResolvedTime => ({ iso: fmt(date) });
const range = (from: Date, to: Date): ResolvedTime => ({ range: { from: fmt(from), to: fmt(to) } });

/** The same day `months` away, clamped to the end of a shorter month (31 January + 1 month is 28 February). */
function addMonths(date: Date, months: number): Date {
  const first = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(date.getUTCDate(), last)));
}

type Period = 'week' | 'month' | 'quarter' | 'year';

/** The Monday-to-Sunday week, month, quarter or year that contains `date`, shifted by `offset` periods. */
function period(unit: Period, offset: number, date: Date): ResolvedTime {
  if (unit === 'week') {
    const monday = addDays(date, -((date.getUTCDay() + 6) % 7) + offset * 7);
    return range(monday, addDays(monday, 6));
  }
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  if (unit === 'year') return range(new Date(Date.UTC(y + offset, 0, 1)), new Date(Date.UTC(y + offset, 11, 31)));
  const size = unit === 'month' ? 1 : 3;
  const first = unit === 'month' ? m : m - (m % 3);
  return range(new Date(Date.UTC(y, first + offset * size, 1)), new Date(Date.UTC(y, first + offset * size + size, 0)));
}

const AMOUNT = '(\\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
const amount = (raw: string) => WORDS[raw] ?? Number(raw);

/**
 * `phrase` against `reference`: today, yesterday, tomorrow, last or next <weekday> (never the reference day itself), N days,
 * weeks or months ago, in N days, weeks or months, and last, this or next week, month, quarter or year. Anything else is
 * undefined, so the caller leaves it to the model or marks it unresolved.
 */
export function resolveRelative(phrase: string, reference: Date): ResolvedTime | undefined {
  const text = phrase
    .toLowerCase()
    .replace(/[.,;!?]+$/g, '')
    .replace(/^(?:on|by|since|until|from|around|about)\s+/, '')
    .replace(/\s+(?:morning|afternoon|evening|night)$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  const today = startOfDay(reference);
  if (text === 'today') return day(today);
  if (text === 'yesterday') return day(addDays(today, -1));
  if (text === 'tomorrow') return day(addDays(today, 1));

  const weekday = /^(last|next) (sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/.exec(text);
  if (weekday) {
    const target = WEEKDAYS.indexOf(weekday[2]);
    const here = today.getUTCDay();
    // Strictly before or after the reference day: "last Friday" on a Friday is a week ago.
    return day(addDays(today, weekday[1] === 'last' ? -(((here - target + 7) % 7) || 7) : ((target - here + 7) % 7) || 7));
  }

  const away = new RegExp(`^${AMOUNT} (day|week|month)s? ago$`).exec(text) ?? new RegExp(`^in ${AMOUNT} (day|week|month)s?$`).exec(text);
  if (away) {
    const sign = text.endsWith('ago') ? -1 : 1;
    const n = amount(away[1]) * sign;
    return day(away[2] === 'month' ? addMonths(today, n) : addDays(today, away[2] === 'week' ? n * 7 : n));
  }

  const span = /^(last|this|next) (week|month|quarter|year)$/.exec(text);
  if (span) return period(span[2] as Period, span[1] === 'last' ? -1 : span[1] === 'next' ? 1 : 0, today);
  return undefined;
}

/** A real calendar date (`2026-11-18`, `2026-11-18T09:00:00Z`) within ten years of the reference, else undefined. */
function validDate(value: string | undefined, reference: Date): string | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(value.trim());
  if (!match) return undefined;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const real = new Date(Date.UTC(y, m - 1, d));
  if (real.getUTCFullYear() !== y || real.getUTCMonth() !== m - 1 || real.getUTCDate() !== d) return undefined; // 2026-02-31
  if (Math.abs(real.getTime() - reference.getTime()) > TEN_YEARS_MS) return undefined;
  return value.trim();
}

/**
 * The model's time answer made safe: the fixed phrase list wins when it knows the words; otherwise the model's ISO date or
 * range is kept when it is real and within ten years of the reference (C28-D4); anything else is `{ unresolved: true }`.
 */
export function checkTime(answer: { text?: string; iso?: string; from?: string; to?: string }, reference: Date): ResolvedTime {
  const known = answer.text ? resolveRelative(answer.text, reference) : undefined;
  if (known) return known;
  const iso = validDate(answer.iso, reference);
  if (iso) return { iso };
  const from = validDate(answer.from, reference);
  const to = validDate(answer.to, reference);
  if (from && to && from <= to) return { range: { from, to } };
  return { unresolved: true };
}
