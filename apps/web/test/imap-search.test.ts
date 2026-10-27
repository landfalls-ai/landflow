/** Email Trigger (IMAP): the Search Criteria parser (IMAP SEARCH text to ImapFlow's SearchObject). */
import { describe, expect, it } from 'vitest';
import { andSearch, ImapSearchError, parseImapSearch } from '@/lib/server/nodes/imap-search';

const fails = (text: string, message: RegExp | string) => expect(() => parseImapSearch(text)).toThrow(message);
const date = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

describe('parseImapSearch', () => {
  it('parses the documented examples', () => {
    expect(parseImapSearch('FROM "billing" SINCE 1-Oct-2026 NOT SUBJECT "spam"')).toEqual({ from: 'billing', since: date(2026, 10, 1), not: { subject: 'spam' } });
    expect(parseImapSearch('OR FROM a FROM b')).toEqual({ or: [{ from: 'a' }, { from: 'b' }] });
    expect(parseImapSearch('LARGER 10000')).toEqual({ larger: 10000 });
    expect(parseImapSearch('HEADER X-Foo bar')).toEqual({ header: { 'X-Foo': 'bar' } });
    expect(parseImapSearch('KEYWORD x')).toEqual({ keyword: 'x' });
  });

  it('is case-insensitive for keys, keeps values, and handles quotes and escapes', () => {
    expect(parseImapSearch('from "Ada Lovelace" subject "say \\"hi\\" \\\\ now"')).toEqual({ from: 'Ada Lovelace', subject: 'say "hi" \\ now' });
    expect(parseImapSearch('FROM "NOT"')).toEqual({ from: 'NOT' });
    expect(parseImapSearch('TEXT "größe"')).toEqual({ text: 'größe' });
  });

  it('flags, UN- forms, sizes, UID sets, ISO dates', () => {
    expect(parseImapSearch('FLAGGED UNANSWERED SMALLER 5')).toEqual({ flagged: true, answered: false, smaller: 5 });
    expect(parseImapSearch('UNSEEN')).toEqual({ seen: false });
    expect(parseImapSearch('ALL')).toEqual({});
    expect(parseImapSearch('UID 100:*,5')).toEqual({ uid: '100:*,5' });
    expect(parseImapSearch('SENTBEFORE 2026-02-28 ON 29-feb-2028')).toEqual({ sentBefore: date(2026, 2, 28), on: date(2028, 2, 29) });
  });

  it('groups with parentheses and nests NOT and OR', () => {
    expect(parseImapSearch('(FROM a SUBJECT b)')).toEqual({ from: 'a', subject: 'b' });
    expect(parseImapSearch('OR (FROM a SINCE 1-Oct-2026) NOT (TO b CC c)')).toEqual({ or: [{ from: 'a', since: date(2026, 10, 1) }, { not: { to: 'b', cc: 'c' } }] });
    expect(parseImapSearch('NOT NOT SEEN')).toEqual({ not: { not: { seen: true } } });
    expect(parseImapSearch('OR OR FROM a FROM b FROM c')).toEqual({ or: [{ or: [{ from: 'a' }, { from: 'b' }] }, { from: 'c' }] });
  });

  it('keeps repeated keys as an AND the compiler can express', () => {
    expect(parseImapSearch('FROM a FROM b')).toEqual({ not: { or: [{ not: { from: 'a' } }, { not: { from: 'b' } }] } });
    expect(parseImapSearch('HEADER X-A 1 HEADER X-B 2')).toEqual({ header: { 'X-A': '1', 'X-B': '2' } });
    expect(parseImapSearch('HEADER X-A 1 HEADER X-A 2')).toMatchObject({ not: { or: expect.any(Array) } });
    expect(andSearch([{ seen: false }, { from: 'a' }])).toEqual({ seen: false, from: 'a' });
    expect(andSearch([{ seen: false }, { seen: true }])).toEqual({ not: { or: [{ not: { seen: false } }, { not: { seen: true } }] } });
  });

  it('rejects unknown keys and says which are supported', () => {
    fails('FOO bar', /unknown search key “FOO” \(position 1\).*FROM/);
    fails('X-GM-RAW "label:x"', /unknown search key/);
    fails('MODSEQ 5', /unknown search key/);
    fails('1:5', /unknown search key/);
    fails('"FROM" a', /expected a search key, got the quoted text/);
  });

  it('rejects unbalanced parentheses and quotes', () => {
    fails('(FROM a', /“\(” at position 1 is never closed/);
    fails('FROM a)', /unexpected “\)” at position 7/);
    fails('()', /empty parentheses/);
    fails('FROM "abc', /quote opened at position 6 is never closed/);
    fails('FROM "a\\nb"', /only \\" and \\\\ may be escaped/);
  });

  it('rejects missing operands, bad dates and bad numbers', () => {
    fails('FROM', /FROM needs a value/);
    fails('NOT', /ends where a search key was expected/);
    fails('OR FROM a', /ends where a search key was expected/);
    fails('SUBJECT (a)', /SUBJECT needs a value/);
    fails('SINCE yesterday', /SINCE needs a date like 1-Oct-2026/);
    fails('SINCE 31-Feb-2026', /not a real date/);
    fails('BEFORE 2026-13-01', /not a real date/);
    fails('SINCE 1-Foo-2026', /not a real date/);
    fails('LARGER ten', /LARGER needs a whole number/);
    fails('LARGER -5', /LARGER needs a whole number/);
    fails('SMALLER 1.5', /SMALLER needs a whole number/);
    fails('UID 1:x', /UID needs a set/);
    fails('HEADER "X Foo" bar', /HEADER needs a field name/);
    fails('HEADER X-Foo', /HEADER needs a value/);
    fails('', /empty/);
    fails('   ', /empty/);
  });

  it('refuses CRLF, NUL, literals and oversize text', () => {
    fails('FROM a\r\nA1 DELETE INBOX', /control characters/);
    fails('FROM "a\nb"', /control characters/);
    fails('FROM a\0', /control characters/);
    fails('FROM {5}', /unexpected character/);
    fails('FROM {5+}', /unexpected character/);
    fails('FROM a\\b', /unexpected character/);
    fails(`FROM ${'a'.repeat(2_001)}`, /longer than 2000/);
    fails(`${'('.repeat(40)}SEEN${')'.repeat(40)}`, /nested more than/);
    fails(Array.from({ length: 101 }, () => 'SEEN').join(' '), /more than 100 terms/);
    expect(() => parseImapSearch('FROM {')).toThrow(ImapSearchError);
  });
});
