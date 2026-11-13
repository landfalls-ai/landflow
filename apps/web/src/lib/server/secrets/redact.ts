/**
 * Redaction of external secret values. Every value a credential field received from `$secrets` is remembered here
 * (in memory only, the most recent few thousand), and replaced by `[redacted]` wherever it would leave the node call:
 *
 * - node responses (outputs and errors), before the engine sees them (./runtime.ts), so executions, checkpoints,
 *   live events and error workflows never hold them;
 * - rows written to the executions, execution steps and checkpoints tables (a second line, lib/server/db hook);
 * - log lines (the logger's scrubber hook) and the error texts of the secrets API.
 *
 * Values shorter than MIN_LENGTH characters aren't redacted: replacing "abc" everywhere would mangle unrelated data.
 * With no secret resolved yet every function returns its input untouched.
 */
import { singleton } from '../singleton';

export const REDACTED = '[redacted]';
/** Shorter values are left alone. */
export const MIN_LENGTH = 6;
const MAX_VALUES = 5000;

interface State {
  /** Value → last time it was resolved (for eviction). */
  values: Map<string, number>;
  /** Longest first, so a value containing another is replaced whole. */
  sorted?: string[];
}

const state = singleton<State>('secret-redactor', () => ({ values: new Map() }));

const leaves = (value: unknown, out: string[] = [], depth = 0): string[] => {
  if (typeof value === 'string') out.push(value);
  else if (typeof value === 'number' && String(value).length >= MIN_LENGTH) out.push(String(value));
  else if (value && typeof value === 'object' && depth < 8) for (const entry of Object.values(value)) leaves(entry, out, depth + 1);
  return out;
};

/**
 * Remember secret values (a string, or every string in an object) so they are redacted from now on. The long lines of
 * a multi-line value count on their own too (a PEM key's), unless `lines` is false (a node parameter that read a
 * secret, whose other lines are the workflow's own text).
 */
export function rememberSecretValues(value: unknown, options: { lines?: boolean; min?: number } = {}): void {
  const min = Math.max(MIN_LENGTH, options.min ?? 0);
  const now = Date.now();
  let added = false;
  for (const text of leaves(value)) {
    const candidates = options.lines === false ? [text] : [text, ...text.split(/\r?\n/).filter((line) => line.trim().length >= Math.max(min, MIN_LENGTH * 2))];
    for (const candidate of candidates) {
      if (candidate.length < min) continue;
      if (!state.values.has(candidate)) added = true;
      state.values.set(candidate, now);
    }
  }
  if (state.values.size > MAX_VALUES) {
    const oldest = [...state.values.entries()].sort((a, b) => a[1] - b[1]).slice(0, state.values.size - MAX_VALUES);
    for (const [key] of oldest) state.values.delete(key);
    added = true;
  }
  if (added) state.sorted = undefined;
}

/** Forget every remembered value (tests). */
export function forgetSecretValues(): void {
  state.values.clear();
  state.sorted = undefined;
}

export const hasSecretValues = () => state.values.size > 0;

function sorted(): string[] {
  state.sorted ??= [...state.values.keys()].sort((a, b) => b.length - a.length);
  return state.sorted;
}

/** A text with every remembered value replaced. */
export function redactText(text: string): string {
  if (!state.values.size || !text) return text;
  let out = text;
  for (const value of sorted()) if (out.includes(value)) out = out.split(value).join(REDACTED);
  return out;
}

/** JSON-escaped forms of the values, as they appear inside a JSON string literal. */
const escaped = (value: string) => JSON.stringify(value).slice(1, -1);

/** JSON text with the values replaced inside its string literals (keys included) only, so the document stays valid. */
export function redactJsonText(text: string): string {
  if (!state.values.size || !text) return text;
  const values = sorted();
  if (!values.some((value) => text.includes(escaped(value)))) return text;
  return text.replace(/"(?:[^"\\]|\\.)*"/g, (literal) => {
    let out = literal;
    for (const value of values) {
      const form = escaped(value);
      if (out.includes(form)) out = out.split(form).join(REDACTED);
    }
    return out;
  });
}

/** A copy of `value` with every remembered value replaced in its strings; `value` itself when nothing matched. */
export function redactValue<T>(value: T, depth = 0): T {
  if (!state.values.size) return value;
  if (typeof value === 'string') return redactText(value) as T;
  if (!value || typeof value !== 'object' || depth > 64) return value;
  if (ArrayBuffer.isView(value)) return value;
  let changed = false;
  if (Array.isArray(value)) {
    const out = value.map((entry) => {
      const next = redactValue(entry, depth + 1);
      if (next !== entry) changed = true;
      return next;
    });
    return (changed ? out : value) as T;
  }
  if (value instanceof Error) {
    const message = redactText(value.message);
    if (message === value.message) return value;
    const copy = new Error(message) as Error & Record<string, unknown>;
    copy.name = value.name;
    for (const [key, entry] of Object.entries(value)) copy[key] = redactValue(entry, depth + 1);
    if (value.stack) copy.stack = redactText(value.stack);
    return copy as T;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const next = redactValue(entry, depth + 1);
    if (next !== entry) changed = true;
    out[key] = next;
  }
  return (changed ? out : value) as T;
}

/** Whether a text holds a remembered value (tests and checks). */
export function containsSecretValue(text: string): boolean {
  if (!state.values.size) return false;
  return sorted().some((value) => text.includes(value) || text.includes(escaped(value)));
}

// ---------------------------------------------------------------------------
// Value patterns: secrets recognised by their shape, for text that was never a `$secrets` value (an upstream error
// that quotes a header, a URL with credentials). The logger applies them to every string it writes. Each pattern is
// anchored on a literal marker and guarded by an `includes`, so a line without the marker costs one scan.
// ---------------------------------------------------------------------------

const PATTERNS: { marker: string[]; pattern: RegExp; replace: string }[] = [
  { marker: ['Bearer'], pattern: /\b(Bearer\s+)(?=[A-Za-z0-9._~+/=-]*[0-9._~+/=-]|[A-Za-z]{24,})[A-Za-z0-9._~+/=-]{8,}/g, replace: `$1${REDACTED}` },
  // Landflow API keys (lf_…) and MCP / debug tokens (lf_mcp_…, lf_dbg_…).
  { marker: ['lf_'], pattern: /\blf_[A-Za-z0-9_-]{12,}/g, replace: REDACTED },
  // `scheme://user:password@host`: the userinfo goes, the host stays.
  { marker: ['@'], pattern: /(\/\/)[^\s/@:?#'"]*:[^\s/?#'"]+@/g, replace: `$1${REDACTED}@` },
  { marker: ['-----BEGIN'], pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, replace: REDACTED },
];

/** A text with the secret-shaped values replaced (the same string when there are none). */
export function redactPatterns(text: string): string {
  let out = text;
  for (const { marker, pattern, replace } of PATTERNS) {
    if (marker.some((m) => out.includes(m))) out = out.replace(pattern, replace);
  }
  return out;
}
