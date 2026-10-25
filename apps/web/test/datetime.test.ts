import { describe, expect, it } from 'vitest';
import { dateTimeNode, diff, durationToIso, formatDate, toIso, toMillis } from '@/lib/server/nodes/datetime';
import { run, runOk } from './helpers';

const BERLIN = 'Europe/Berlin';
const NY = 'America/New_York';
const UTC = 'UTC';
const at = (iso: string) => Date.parse(iso);

/** Run the node on one item and return the value it wrote. */
async function value(parameters: Record<string, unknown>, field = '') {
  const result = await runOk(dateTimeNode, parameters, [{ keep: true }]);
  const json = result.json()[0];
  expect(json.keep).toBe(true);
  return field ? json[field] : Object.values(json).at(-1);
}

describe('time zones', () => {
  it('writes ISO 8601 with the zone offset, across the October DST change', () => {
    expect(toIso(at('2026-10-25T00:30:00Z'), BERLIN)).toBe('2026-10-25T02:30:00.000+02:00');
    expect(toIso(at('2026-10-25T01:30:00Z'), BERLIN)).toBe('2026-10-25T02:30:00.000+01:00');
    expect(toIso(at('2026-10-25T01:30:00Z'), UTC)).toBe('2026-10-25T01:30:00.000Z');
  });

  it('reads local times in the zone; a time in the spring gap moves forward', () => {
    expect(toIso(toMillis('2026-10-25', BERLIN), BERLIN)).toBe('2026-10-25T00:00:00.000+02:00');
    expect(toIso(toMillis('2026-03-29T02:30:00', BERLIN), BERLIN)).toBe('2026-03-29T03:30:00.000+02:00');
    expect(toIso(toMillis('2026-10-25T10:00:00+05:30', BERLIN), UTC)).toBe('2026-10-25T04:30:00.000Z');
  });

  it('reads timestamps, Date objects, RFC 2822 and custom formats', () => {
    const ms = at('2026-10-25T14:05:09Z');
    expect(toMillis(ms / 1000, UTC)).toBe(ms);
    expect(toMillis(String(ms), UTC)).toBe(ms);
    expect(toMillis(new Date(ms), UTC)).toBe(ms);
    expect(toMillis('Sun, 25 Oct 2026 14:05:09 GMT', BERLIN)).toBe(ms);
    expect(toIso(toMillis('25/10/2026 14:30', UTC, 'dd/MM/yyyy HH:mm'), UTC)).toBe('2026-10-25T14:30:00.000Z');
    expect(toIso(toMillis('Oct 5, 2026 2:30 PM', NY, 'MMM d, yyyy h:mm a'), NY)).toBe('2026-10-05T14:30:00.000-04:00');
    expect(() => toMillis('25.10.2026', UTC, 'dd/MM/yyyy')).toThrow(/doesn't match the format/);
    expect(() => toMillis('not a date', UTC)).toThrow(/Invalid date/);
    expect(() => toMillis('2026-02-30', UTC)).toThrow(/Invalid date/);
    expect(() => toMillis('', UTC)).toThrow(/No date given/);
  });
});

describe('formatting', () => {
  const ms = at('2026-10-25T14:05:09.007Z');

  it('supports Luxon tokens and quoted text', () => {
    expect(formatDate(ms, NY, 'yyyy-MM-dd HH:mm:ss.SSS')).toBe('2026-10-25 10:05:09.007');
    expect(formatDate(ms, NY, "EEEE, MMMM d 'at' h:mm a")).toBe('Sunday, October 25 at 10:05 AM');
    expect(formatDate(ms, NY, 'ZZ|Z|ZZZ|z')).toBe('-04:00|-4|-0400|America/New_York');
    expect(formatDate(ms, UTC, "'Week' W, 'Q'q, 'day' o, EEE dd MMM yy")).toBe('Week 43, Q4, day 298, Sun 25 Oct 26');
    expect(formatDate(ms, UTC, 'X|x')).toBe(`${Math.floor(ms / 1000)}|${ms}`);
    expect(formatDate(ms, UTC, "h 'o''clock'")).toBe("2 o'clock");
  });

  it('formats with presets and a custom format in the node', async () => {
    expect(await value({ operation: 'formatDate', date: '2026-10-25T14:05:09.007Z', format: 'MMMM dd yyyy', options: { timezone: NY } }, 'formattedDate')).toBe(
      'October 25 2026',
    );
    expect(await value({ operation: 'formatDate', date: '2026-10-25T14:05:09.007Z', format: 'iso', options: { timezone: NY } })).toBe(
      '2026-10-25T10:05:09.007-04:00',
    );
    expect(
      await value({
        operation: 'formatDate',
        date: '25/10/2026',
        format: 'custom',
        customFormat: 'yyyy-MM-dd',
        options: { timezone: UTC, fromFormat: 'dd/MM/yyyy' },
      }),
    ).toBe('2026-10-25');
  });
});

describe('Date & Time node', () => {
  it('gets the current date, with or without the time', async () => {
    const now = await value({ operation: 'getCurrentDate', options: { timezone: UTC } }, 'currentDate');
    expect(Math.abs(Date.parse(String(now)) - Date.now())).toBeLessThan(5_000);
    expect(await value({ operation: 'getCurrentDate', includeTime: false, options: { timezone: UTC } })).toMatch(/T00:00:00\.000Z$/);
    const nested = await runOk(
      dateTimeNode,
      { operation: 'getCurrentDate', outputFieldName: 'meta.today', includeTime: false, options: { timezone: BERLIN } },
      [{}],
    );
    expect((nested.json()[0].meta as Record<string, string>).today).toMatch(/T00:00:00\.000\+0[12]:00$/);
  });

  it('adds calendar days across DST at the same local time, hours exactly', async () => {
    const base = { operation: 'addToDate', magnitude: '2026-10-24T12:00:00', duration: 1, options: { timezone: BERLIN } };
    expect(await value({ ...base, timeUnit: 'days' }, 'newDate')).toBe('2026-10-25T12:00:00.000+01:00');
    expect(await value({ ...base, timeUnit: 'hours', duration: 24 })).toBe('2026-10-25T11:00:00.000+01:00');
  });

  it('clamps month ends, subtracts, and handles fractional days', async () => {
    const utc = { options: { timezone: UTC } };
    expect(await value({ ...utc, operation: 'addToDate', magnitude: '2026-01-31', timeUnit: 'months', duration: 1 })).toBe('2026-02-28T00:00:00.000Z');
    expect(await value({ ...utc, operation: 'addToDate', magnitude: '2028-01-31', timeUnit: 'months', duration: 1 })).toBe('2028-02-29T00:00:00.000Z');
    expect(await value({ ...utc, operation: 'subtractFromDate', magnitude: '2026-05-31T10:00:00Z', timeUnit: 'quarters', duration: 1 })).toBe(
      '2026-02-28T10:00:00.000Z',
    );
    expect(await value({ ...utc, operation: 'addToDate', magnitude: '2026-01-01T00:00:00Z', timeUnit: 'days', duration: 1.5 })).toBe(
      '2026-01-02T12:00:00.000Z',
    );
    expect(await value({ ...utc, operation: 'subtractFromDate', magnitude: '2026-01-01T00:00:00Z', timeUnit: 'years', duration: 3 })).toBe(
      '2023-01-01T00:00:00.000Z',
    );
    const fractional = await run(dateTimeNode, { ...utc, operation: 'addToDate', magnitude: '2026-01-01', timeUnit: 'months', duration: 1.5 }, [{}]);
    expect(fractional.error?.message).toMatch(/whole months/);
    expect(fractional.error?.itemIndex).toBe(0);
  });

  it('gets the time between dates in the chosen units', async () => {
    const between = (startDate: string, endDate: string, units: string[], options: Record<string, unknown> = { timezone: UTC }) =>
      value({ operation: 'getTimeBetweenDates', startDate, endDate, units, options }, 'timeDifference');
    expect(await between('2026-01-01T00:00:00Z', '2026-01-03T12:00:00Z', ['day'])).toEqual({ days: 2.5 });
    expect(await between('2026-01-15', '2026-03-20', ['month', 'day'])).toEqual({ months: 2, days: 5 });
    expect(await between('2026-01-01T10:00:00Z', '2026-01-01T12:30:00Z', ['hour', 'minute'])).toEqual({ hours: 2, minutes: 30 });
    expect(await between('2026-01-03T12:00:00Z', '2026-01-01T00:00:00Z', ['day'])).toEqual({ days: -2.5 });
    expect(await between('2026-10-24T12:00:00', '2026-10-25T12:00:00', ['day'], { timezone: BERLIN })).toEqual({ days: 1 });
    expect(await between('2026-10-24T12:00:00', '2026-10-25T12:00:00', ['hour'], { timezone: BERLIN })).toEqual({ hours: 25 });
    expect(await between('2026-01-15', '2026-03-20', ['month', 'day'], { timezone: UTC, isoString: true })).toBe('P2M5D');
    expect(durationToIso({ days: 2.5 })).toBe('P2.5D');
    expect(durationToIso({ hours: 1, seconds: 1, milliseconds: 500 })).toBe('PT1H1.5S');
    expect(diff(at('2026-01-31T00:00:00Z'), at('2026-03-01T00:00:00Z'), UTC, ['months', 'days'])).toEqual({ months: 1, days: 1 });
  });

  it('extracts parts of a date in the zone', async () => {
    const part = (p: string, timezone = UTC) => value({ operation: 'extractDate', date: '2026-10-25T14:05:09Z', part: p, options: { timezone } }, 'datePart');
    expect(await part('week')).toBe(43);
    expect(await part('weekday')).toBe(7);
    expect(await part('quarter')).toBe(4);
    expect(await part('dayOfYear')).toBe(298);
    expect(await part('month')).toBe(10);
    expect(await part('hour', 'Asia/Tokyo')).toBe(23);
  });

  it('rounds dates down to a unit start, or up to the next one', async () => {
    const round = (mode: string, toNearest: string, date = '2026-10-22T15:45:30Z', timezone = UTC) =>
      value({ operation: 'roundDate', date, mode, toNearest, options: { timezone } }, 'roundedDate');
    expect(await round('roundDown', 'week')).toBe('2026-10-19T00:00:00.000Z');
    expect(await round('roundDown', 'month')).toBe('2026-10-01T00:00:00.000Z');
    expect(await round('roundDown', 'hour')).toBe('2026-10-22T15:00:00.000Z');
    expect(await round('roundUp', 'month')).toBe('2026-11-01T00:00:00.000Z');
    expect(await round('roundUp', 'day')).toBe('2026-10-23T00:00:00.000Z');
    expect(await round('roundDown', 'day', '2026-10-25T12:00:00+01:00', BERLIN)).toBe('2026-10-25T00:00:00.000+02:00');
  });

  it('rejects unknown time zones and reports bad dates per item', async () => {
    expect((await run(dateTimeNode, { operation: 'getCurrentDate', options: { timezone: 'Mars/Base' } }, [{}])).error?.message).toMatch(/Unknown time zone/);
    const bad = await run(dateTimeNode, { operation: 'formatDate', date: 'tomorrow-ish', format: 'yyyy' }, [{}]);
    expect(bad.error).toMatchObject({ message: expect.stringMatching(/Invalid date/), itemIndex: 0 });
  });
});
