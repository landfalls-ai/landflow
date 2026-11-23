/**
 * C28 T-1: the fixed relative-date phrases resolved against a reference date (memory/dates.ts), and the check that keeps a
 * model's own date answer honest (AS-1, AS-7). Pure: the reference date is always passed in.
 */
import { describe, expect, it } from 'vitest';
import { checkTime, resolveRelative } from '@/lib/server/memory/dates';

const FRIDAY = new Date('2026-11-20T15:30:00Z');
const MONDAY = new Date('2026-03-02T00:00:00Z');
const day = (phrase: string, reference = FRIDAY) => resolveRelative(phrase, reference);

describe('resolveRelative', () => {
  it('names single days (AS-1)', () => {
    expect(day('last Monday')).toEqual({ iso: '2026-11-16' });
    expect(day('yesterday')).toEqual({ iso: '2026-11-19' });
    expect(day('today')).toEqual({ iso: '2026-11-20' });
    expect(day('Tomorrow')).toEqual({ iso: '2026-11-21' });
    expect(day('next Monday')).toEqual({ iso: '2026-11-23' });
    expect(day('last Friday')).toEqual({ iso: '2026-11-13' }); // never the reference day itself
    expect(day('next Friday')).toEqual({ iso: '2026-11-27' });
    expect(day('on last tuesday')).toEqual({ iso: '2026-11-17' });
  });

  it('counts days, weeks and months away', () => {
    expect(day('two weeks ago')).toEqual({ iso: '2026-11-06' });
    expect(day('3 days ago')).toEqual({ iso: '2026-11-17' });
    expect(day('a week ago')).toEqual({ iso: '2026-11-13' });
    expect(day('in 2 days')).toEqual({ iso: '2026-11-22' });
    expect(day('in three weeks')).toEqual({ iso: '2026-12-11' });
    expect(day('two months ago')).toEqual({ iso: '2026-09-20' });
    expect(day('one month ago', new Date('2026-03-31T00:00:00Z'))).toEqual({ iso: '2026-02-28' }); // the day clamps to the month's end
    expect(day('in 1 month', new Date('2026-01-31T00:00:00Z'))).toEqual({ iso: '2026-02-28' });
  });

  it('names periods as ranges', () => {
    expect(day('next quarter')).toEqual({ range: { from: '2027-01-01', to: '2027-03-31' } });
    expect(day('this quarter')).toEqual({ range: { from: '2026-10-01', to: '2026-12-31' } });
    expect(day('last quarter')).toEqual({ range: { from: '2026-07-01', to: '2026-09-30' } });
    expect(day('last week')).toEqual({ range: { from: '2026-11-09', to: '2026-11-15' } }); // Monday to Sunday
    expect(day('next week')).toEqual({ range: { from: '2026-11-23', to: '2026-11-29' } });
    expect(day('last month')).toEqual({ range: { from: '2026-10-01', to: '2026-10-31' } });
    expect(day('next month')).toEqual({ range: { from: '2026-12-01', to: '2026-12-31' } });
    expect(day('last year')).toEqual({ range: { from: '2025-01-01', to: '2025-12-31' } });
    expect(day('next year')).toEqual({ range: { from: '2027-01-01', to: '2027-12-31' } });
    expect(day('last week', MONDAY)).toEqual({ range: { from: '2026-02-23', to: '2026-03-01' } });
  });

  it('leaves anything else to the model (AS-7)', () => {
    expect(day('sometime soon')).toBeUndefined();
    expect(day('a while back')).toBeUndefined();
    expect(day('')).toBeUndefined();
    expect(day('last Mondayish')).toBeUndefined();
  });

  it('reads the reference as a UTC calendar day', () => {
    expect(day('yesterday', new Date('2026-11-20T23:59:59Z'))).toEqual({ iso: '2026-11-19' });
    expect(day('yesterday', new Date('2026-11-21T00:00:00Z'))).toEqual({ iso: '2026-11-20' });
  });
});

describe('checkTime', () => {
  it('lets the fixed phrase override what the model said (C28-D4)', () => {
    expect(checkTime({ text: 'last Monday', iso: '2026-11-09' }, FRIDAY)).toEqual({ iso: '2026-11-16' });
  });

  it('keeps a valid ISO date or range the model gave for a phrase it resolved itself', () => {
    expect(checkTime({ text: 'the week of the offsite', iso: '2026-11-18' }, FRIDAY)).toEqual({ iso: '2026-11-18' });
    expect(checkTime({ text: 'Q1', from: '2027-01-01', to: '2027-03-31' }, FRIDAY)).toEqual({ range: { from: '2027-01-01', to: '2027-03-31' } });
  });

  it('drops a date more than ten years away, a malformed one, or an inverted range as unresolved (AS-7)', () => {
    expect(checkTime({ text: 'back then', iso: '2015-01-01' }, FRIDAY)).toEqual({ unresolved: true });
    expect(checkTime({ text: 'later', iso: '2037-01-01' }, FRIDAY)).toEqual({ unresolved: true });
    expect(checkTime({ text: 'soon', iso: 'next-ish' }, FRIDAY)).toEqual({ unresolved: true });
    expect(checkTime({ text: 'soon', iso: '2026-02-31' }, FRIDAY)).toEqual({ unresolved: true });
    expect(checkTime({ text: 'soon', from: '2027-03-31', to: '2027-01-01' }, FRIDAY)).toEqual({ unresolved: true });
    expect(checkTime({ text: 'sometime soon' }, FRIDAY)).toEqual({ unresolved: true });
    expect(checkTime({}, FRIDAY)).toEqual({ unresolved: true });
  });

  it('accepts a full timestamp and keeps its date', () => {
    expect(checkTime({ iso: '2026-11-18T09:00:00Z' }, FRIDAY)).toEqual({ iso: '2026-11-18T09:00:00Z' });
  });
});
