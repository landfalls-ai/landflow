/**
 * IMAP SEARCH criteria text (RFC 3501 §6.4.4) for the Email Trigger (IMAP): a tokenizer and parser of our own, so a
 * bad key, an unbalanced parenthesis or quote, a bad date or number fails with a clear message before anything is
 * sent, and no CR, LF, NUL or `{n}` literal can reach the server. The result is the SearchObject ImapFlow compiles
 * (and quotes) itself. `FROM "billing" SINCE 1-Oct-2026 NOT SUBJECT "spam"`, `OR FROM a FROM b`, `LARGER 10000`,
 * `HEADER X-Foo bar`, `KEYWORD x`, `UID 100:*`, parentheses and any nesting of NOT / OR are supported; extension keys
 * (X-GM-RAW, MODSEQ, …) and bare sequence sets are not.
 */
import type { SearchObject } from 'imapflow';

export const MAX_CRITERIA_LENGTH = 2_000;
const MAX_DEPTH = 16;
const MAX_TERMS = 100;

export class ImapSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImapSearchError';
  }
}

interface Token {
  type: 'open' | 'close' | 'atom' | 'string';
  value: string;
  at: number;
}

const FLAG_KEYS: Record<string, [keyof SearchObject, boolean]> = {
  ANSWERED: ['answered', true],
  UNANSWERED: ['answered', false],
  DELETED: ['deleted', true],
  UNDELETED: ['deleted', false],
  DRAFT: ['draft', true],
  UNDRAFT: ['draft', false],
  FLAGGED: ['flagged', true],
  UNFLAGGED: ['flagged', false],
  SEEN: ['seen', true],
  UNSEEN: ['seen', false],
  NEW: ['new', true],
  OLD: ['old', true],
  RECENT: ['recent', true],
};
const TEXT_KEYS: Record<string, keyof SearchObject> = { BCC: 'bcc', BODY: 'body', CC: 'cc', FROM: 'from', SUBJECT: 'subject', TEXT: 'text', TO: 'to', KEYWORD: 'keyword', UNKEYWORD: 'unKeyword' };
const DATE_KEYS: Record<string, keyof SearchObject> = { BEFORE: 'before', ON: 'on', SINCE: 'since', SENTBEFORE: 'sentBefore', SENTON: 'sentOn', SENTSINCE: 'sentSince' };
const SIZE_KEYS: Record<string, keyof SearchObject> = { LARGER: 'larger', SMALLER: 'smaller' };
export const SUPPORTED_KEYS = ['ALL', ...Object.keys(FLAG_KEYS), ...Object.keys(TEXT_KEYS), ...Object.keys(DATE_KEYS), ...Object.keys(SIZE_KEYS), 'HEADER', 'UID', 'NOT', 'OR'];

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t') {
      i++;
    } else if (c === '(') {
      tokens.push({ type: 'open', value: c, at: i++ });
    } else if (c === ')') {
      tokens.push({ type: 'close', value: c, at: i++ });
    } else if (c === '"') {
      const at = i++;
      let value = '';
      let closed = false;
      while (i < text.length) {
        const d = text[i];
        if (d === '\\') {
          const next = text[i + 1];
          if (next !== '"' && next !== '\\') throw new ImapSearchError(`Search criteria: only \\" and \\\\ may be escaped in a quoted string (position ${i + 1})`);
          value += next;
          i += 2;
        } else if (d === '"') {
          closed = true;
          i++;
          break;
        } else {
          value += d;
          i++;
        }
      }
      if (!closed) throw new ImapSearchError(`Search criteria: the quote opened at position ${at + 1} is never closed`);
      tokens.push({ type: 'string', value, at });
    } else {
      const at = i;
      while (i < text.length && !/[\s()"]/.test(text[i])) i++;
      const value = text.slice(at, i);
      if (/[{}\\%]/.test(value) || (value.includes('*') && !/^[\d*:,]+$/.test(value))) throw new ImapSearchError(`Search criteria: unexpected character in “${value}” (position ${at + 1}); quote the value to search for it`);
      tokens.push({ type: 'atom', value, at });
    }
  }
  return tokens;
}

/** `1-Oct-2026` (RFC 3501) or `2026-10-01`, a real calendar date, as UTC midnight. */
function parseDate(raw: string, key: string): Date {
  let day: number, month: number, year: number;
  let m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(raw);
  if (m) {
    day = Number(m[1]);
    month = MONTHS.indexOf(m[2].toLowerCase());
    year = Number(m[3]);
  } else if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw))) {
    year = Number(m[1]);
    month = Number(m[2]) - 1;
    day = Number(m[3]);
  } else {
    throw new ImapSearchError(`Search criteria: ${key} needs a date like 1-Oct-2026 or 2026-10-01, got “${raw}”`);
  }
  const date = new Date(Date.UTC(year, month, day));
  if (month < 0 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) throw new ImapSearchError(`Search criteria: ${key} “${raw}” is not a real date`);
  return date;
}

function cleanText(value: string, key: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value)) throw new ImapSearchError(`Search criteria: the value of ${key} contains a control character (line breaks are not allowed)`);
  return value;
}

/** Two criteria objects ANDed: merged while their keys differ, else De Morgan (NOT (NOT a OR NOT b)), which SearchObject can say. */
export function andSearch(parts: SearchObject[]): SearchObject {
  const groups: SearchObject[] = [];
  for (const part of parts) {
    const target = groups.find((g) => Object.keys(part).every((k) => !(k in g) || (k === 'header' && !Object.keys(part.header!).some((h) => h in g.header!))));
    if (!target) {
      groups.push({ ...part, ...(part.header && { header: { ...part.header } }) });
      continue;
    }
    const header = target.header || part.header ? { ...target.header, ...part.header } : undefined;
    Object.assign(target, part, header && { header });
  }
  if (groups.length <= 1) return groups[0] ?? {};
  return { not: { or: groups.map((g) => ({ not: g })) } };
}

/** Parses IMAP SEARCH criteria text into ImapFlow's SearchObject; throws ImapSearchError with a clear message. */
export function parseImapSearch(text: string): SearchObject {
  if (text.length > MAX_CRITERIA_LENGTH) throw new ImapSearchError(`Search criteria: longer than ${MAX_CRITERIA_LENGTH} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(text)) throw new ImapSearchError('Search criteria: line breaks and control characters are not allowed');
  const tokens = tokenize(text);
  if (!tokens.length) throw new ImapSearchError('Search criteria: empty');
  let pos = 0;
  let terms = 0;

  const where = (t?: Token) => (t ? `at position ${t.at + 1}` : 'at the end');
  const value = (key: string): Token => {
    const t = tokens[pos++];
    if (!t || t.type === 'open' || t.type === 'close') throw new ImapSearchError(`Search criteria: ${key} needs a value (${where(t)})`);
    return t;
  };

  /** One search key. */
  const key = (depth: number): SearchObject => {
    if (depth > MAX_DEPTH) throw new ImapSearchError(`Search criteria: nested more than ${MAX_DEPTH} levels`);
    if (++terms > MAX_TERMS) throw new ImapSearchError(`Search criteria: more than ${MAX_TERMS} terms`);
    const t = tokens[pos++];
    if (!t) throw new ImapSearchError('Search criteria: ends where a search key was expected');
    if (t.type === 'close') throw new ImapSearchError(`Search criteria: unexpected “)” at position ${t.at + 1}`);
    if (t.type === 'open') {
      const inner = list(depth + 1, true);
      const close = tokens[pos++];
      if (!close || close.type !== 'close') throw new ImapSearchError(`Search criteria: the “(” at position ${t.at + 1} is never closed`);
      return inner;
    }
    if (t.type === 'string') throw new ImapSearchError(`Search criteria: expected a search key, got the quoted text “${t.value}” (position ${t.at + 1})`);
    const name = t.value.toUpperCase();
    if (name === 'ALL') return {};
    if (name === 'NOT') return { not: key(depth + 1) };
    if (name === 'OR') {
      const a = key(depth + 1);
      const b = key(depth + 1);
      return { or: [a, b] };
    }
    if (FLAG_KEYS[name]) return { [FLAG_KEYS[name][0]]: FLAG_KEYS[name][1] };
    if (TEXT_KEYS[name]) return { [TEXT_KEYS[name]]: cleanText(value(name).value, name) };
    if (DATE_KEYS[name]) return { [DATE_KEYS[name]]: parseDate(value(name).value, name) };
    if (SIZE_KEYS[name]) {
      const n = value(name).value;
      if (!/^\d{1,12}$/.test(n)) throw new ImapSearchError(`Search criteria: ${name} needs a whole number of bytes, got “${n}”`);
      return { [SIZE_KEYS[name]]: Number(n) };
    }
    if (name === 'HEADER') {
      const field = cleanText(value(name).value, name);
      if (!field || /[\s:]/.test(field)) throw new ImapSearchError(`Search criteria: HEADER needs a field name like X-Foo (no spaces or colon), got “${field}”`);
      // The value may be empty (`HEADER X-Foo ""`): the field merely has to exist.
      return { header: { [field]: cleanText(value(name).value, name) } };
    }
    if (name === 'UID') {
      const set = value(name).value;
      if (!/^(\d+|\*)(:(\d+|\*))?(,(\d+|\*)(:(\d+|\*))?)*$/.test(set)) throw new ImapSearchError(`Search criteria: UID needs a set like 100, 5:20 or 100:*, got “${set}”`);
      return { uid: set };
    }
    throw new ImapSearchError(`Search criteria: unknown search key “${t.value}” (position ${t.at + 1}). Supported: ${SUPPORTED_KEYS.join(', ')}`);
  };

  /** Keys until the end, or the closing parenthesis; implicitly ANDed. */
  const list = (depth: number, nested: boolean): SearchObject => {
    const parts: SearchObject[] = [];
    while (pos < tokens.length && !(nested && tokens[pos].type === 'close')) parts.push(key(depth));
    if (!parts.length) throw new ImapSearchError(`Search criteria: empty parentheses (position ${(tokens[pos - 1]?.at ?? 0) + 1})`);
    return andSearch(parts);
  };

  const result = list(0, false);
  if (pos < tokens.length) throw new ImapSearchError(`Search criteria: unexpected “${tokens[pos].value}” at position ${tokens[pos].at + 1}`);
  return result;
}
