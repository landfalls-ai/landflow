/**
 * The poll trigger's cursor and seen set (spec 2.3). SAP's change timestamps are weak (a date without a time, a time zone, two fields
 * that disagree), so a poll re-reads a window before the cursor and emits only records whose signature (key plus ETag, else a hash of
 * the content) it has not emitted yet. A record that changed again has a new signature and is emitted again; a re-read is silent.
 */
import { createHash } from 'node:crypto';
import type { JsonObject } from '@landflow/sdk';

export interface PollState extends JsonObject {
  /** The highest timestamp seen, ISO 8601. */
  cursor: string;
  /** Signature -> timestamp (ms) of the records inside the overlap window. */
  seen: Record<string, number>;
  /** What the state belongs to: a change of service, entity set, property or filter starts again from a baseline. */
  scope: string;
}

export const MAX_SEEN = 5000;
export const DEFAULT_OVERLAP_SECONDS = 300;
export const DAY_MS = 24 * 60 * 60 * 1000;

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** `key|etag`, or `key|hash` of the plain content when SAP sent no ETag. */
export function signature(record: JsonObject): string {
  const keys = isObject(record.__keys) ? JSON.stringify(Object.entries(record.__keys).sort(([a], [b]) => a.localeCompare(b))) : '';
  const etag = typeof record.__etag === 'string' ? record.__etag : '';
  const plain = Object.fromEntries(Object.entries(record).filter(([k]) => !k.startsWith('__')));
  const content = etag || createHash('sha1').update(JSON.stringify(plain)).digest('hex').slice(0, 16);
  const id = keys || createHash('sha1').update(JSON.stringify(Object.entries(plain).slice(0, 3))).digest('hex').slice(0, 12);
  return `${id}|${content}`;
}

/** The timestamp of a record in ms; undefined when the property is missing or not a date. */
export function timestampOf(record: JsonObject, property: string): number | undefined {
  const value = record[property];
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

export const scopeOf = (parts: Array<string | undefined>) => createHash('sha1').update(parts.map((p) => p ?? '').join('\u0001')).digest('hex').slice(0, 16);

export const overlapMs = (seconds: unknown, dateOnly: boolean) => {
  const n = Number(seconds);
  const ms = (Number.isFinite(n) && n >= 0 ? n : DEFAULT_OVERLAP_SECONDS) * 1000;
  // A date-only field has no time: re-read from the start of the previous day.
  return dateOnly ? Math.max(ms, DAY_MS + 1000) : ms;
};

export interface Advance {
  /** Records to emit, oldest first. */
  fresh: JsonObject[];
  state: PollState;
  /** The page was full, everything in it was seen and the cursor did not move: the next poll would read the same page. */
  stuck: boolean;
}

/**
 * Takes the records of the window (ordered oldest first) and the previous state; returns what is new and the next state. `records`
 * without a timestamp are emitted by signature but do not move the cursor.
 */
export function advance(records: JsonObject[], previous: PollState | undefined, property: string, overlap: number, scope: string, pageFull = false): Advance {
  const seen = previous?.seen ?? {};
  const before = previous ? Date.parse(previous.cursor) : 0;
  const fresh: JsonObject[] = [];
  let cursor = Number.isFinite(before) ? before : 0;
  for (const record of records) {
    const sig = signature(record);
    if (!(sig in seen)) fresh.push(record);
    const ts = timestampOf(record, property);
    if (ts !== undefined && ts > cursor) cursor = ts;
  }
  const window = cursor - overlap;
  const next: Record<string, number> = {};
  for (const record of records) {
    const ts = timestampOf(record, property) ?? cursor;
    if (ts >= window) next[signature(record)] = ts;
  }
  let entries = Object.entries(next);
  if (entries.length > MAX_SEEN) entries = entries.sort(([, a], [, b]) => b - a).slice(0, MAX_SEEN);
  const moved = cursor > (Number.isFinite(before) ? before : 0);
  return { fresh, state: { cursor: new Date(cursor).toISOString(), seen: Object.fromEntries(entries), scope }, stuck: pageFull && fresh.length === 0 && !moved && records.length > 0 };
}

/** The baseline: everything in the window counts as seen, nothing is emitted. */
export function baseline(records: JsonObject[], property: string, overlap: number, scope: string): PollState {
  return advance(records, undefined, property, overlap, scope).state;
}
