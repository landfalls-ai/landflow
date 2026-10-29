import { createHash } from 'node:crypto';

export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A string for any scalar, '' for null/undefined/objects. */
export function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return '';
}

/** First non-empty string among the values. */
export function firstStr(...values: unknown[]): string {
  for (const v of values) {
    const s = str(v).trim();
    if (s) return s;
  }
  return '';
}

export const nul = (s: string): string | null => (s ? s : null);

export const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/**
 * Read a dot path. Numeric segments index arrays; a key that itself contains dots ("kubernetes.io/name") is found
 * by trying the longest key first at every level.
 */
export function getPath(value: unknown, path: string): unknown {
  const trimmed = path.trim();
  if (!trimmed) return value;
  return walk(value, trimmed.split('.'));
}

function walk(value: unknown, segs: string[]): unknown {
  if (segs.length === 0) return value;
  if (Array.isArray(value)) {
    const index = Number(segs[0]);
    return Number.isInteger(index) ? walk(value[index], segs.slice(1)) : undefined;
  }
  if (!isObj(value)) return undefined;
  for (let n = segs.length; n >= 1; n--) {
    const key = segs.slice(0, n).join('.');
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const found = walk(value[key], segs.slice(n));
      if (found !== undefined || n === 1) return found;
    }
  }
  return undefined;
}

/** Parse JSON leniently: returns undefined instead of throwing. */
export function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Parse a JSON-object parameter that may already be an object. Throws on bad JSON. */
export function jsonObjectParam(value: unknown, what: string): Obj {
  if (value === undefined || value === null || value === '') return {};
  if (isObj(value)) return value;
  if (typeof value === 'string') {
    const parsed = tryJson(value);
    if (isObj(parsed)) return parsed;
  }
  throw new Error(`${what} must be a JSON object`);
}

/** ISO 8601 for ISO strings, epoch seconds or milliseconds; undefined for blanks and the zero time. */
export function toIso(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  let ms: number;
  if (typeof v === 'number' || (typeof v === 'string' && /^\d{9,13}(\.\d+)?$/.test(v.trim()))) {
    const n = Number(v);
    ms = n < 1e11 ? n * 1000 : n;
  } else if (typeof v === 'string') {
    if (v.startsWith('0001-01-01')) return undefined;
    // Wazuh writes offsets as +0000.
    ms = Date.parse(v.trim().replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
  } else {
    return undefined;
  }
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** A string map: scalar values become strings, everything else is dropped. */
export function stringMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObj(v)) return out;
  for (const [k, val] of Object.entries(v)) {
    const s = str(val);
    if (s !== '' || typeof val === 'string') out[k] = s;
  }
  return out;
}

export type LinkKind = 'runbook' | 'dashboard' | 'alert' | 'other';
export interface Link {
  kind: LinkKind;
  url: string;
}

/** http(s) only, deduplicated, at most 10. */
export function cleanLinks(links: Array<{ kind: LinkKind; url: unknown }>): Link[] {
  const out: Link[] = [];
  const seen = new Set<string>();
  for (const { kind, url } of links) {
    const s = str(url).trim();
    if (!/^https?:\/\/[^\s]+$/i.test(s) || seen.has(s)) continue;
    try {
      new URL(s);
    } catch {
      continue;
    }
    seen.add(s);
    out.push({ kind, url: s });
    if (out.length >= 10) break;
  }
  return out;
}
