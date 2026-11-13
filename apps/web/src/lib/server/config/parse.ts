/**
 * Environment parsers: pure, never throw, never return NaN. A value that does not parse falls back to the default and
 * is recorded as an issue (`configIssues()`, logged once per name at warn), so a typo in a variable degrades to the
 * documented default instead of NaN reaching a timer. The `env*` readers read `process.env` at call time, never at
 * import, so a test or a late `process.env` change is seen.
 *
 * This module imports nothing from the host except the logger, loaded lazily, so any module can import config.
 */

export interface ConfigIssue {
  name: string;
  message: string;
  /** The offending value; absent for secrets. */
  value?: string;
}

/**
 * Names that hold secrets, by shape: never echoed here, shown as `[set]` by checkConfig (check.ts, which also has an
 * explicit list). One pattern for both, so they can't drift.
 */
export const SECRET_NAME = /(SECRET|PASSWORD|_PASS$|TOKEN|HEADERS|CREDENTIALS|API_KEY|_KEY$)/i;
/** URLs may carry credentials in their userinfo: an invalid one is not echoed either. */
const URL_NAME = /URL$/i;

const issues = new Map<string, ConfigIssue>();

/** Everything that fell back so far, one entry per variable name. */
export function configIssues(): ConfigIssue[] {
  return [...issues.values()];
}

export function resetConfigIssues(): void {
  issues.clear();
}

function record(name: string | undefined, message: string, value: string | undefined) {
  if (!name || issues.has(name)) return;
  const issue: ConfigIssue = { name, message, ...(value !== undefined && !SECRET_NAME.test(name) && !URL_NAME.test(name) && { value }) };
  issues.set(name, issue);
  // The logger sits in telemetry, which may import config: load it lazily and never let logging break parsing.
  void import('../telemetry/logger')
    .then(({ logger }) => logger.warn('config.invalid', { variable: name, reason: message, ...(issue.value !== undefined && { value: issue.value }) }))
    .catch(() => undefined);
}

const TRUE = /^(1|true|yes|on)$/i;
const FALSE = /^(0|false|no|off)$/i;

/** `1,true,yes,on` is true, `0,false,no,off` false (any case); empty is the fallback; anything else is the fallback plus an issue. */
export function flag(value: string | undefined, fallback: boolean, name?: string): boolean {
  const v = value?.trim();
  if (!v) return fallback;
  if (TRUE.test(v)) return true;
  if (FALSE.test(v)) return false;
  record(name, `expected true or false, using ${fallback}`, v);
  return fallback;
}

export interface NumberOptions {
  fallback: number;
  min?: number;
  max?: number;
  name?: string;
}

/** A finite number clamped to min/max; empty or invalid is the fallback (invalid also records an issue). */
export function number(value: string | undefined, { fallback, min, max, name }: NumberOptions): number {
  const v = value?.trim();
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    record(name, `expected a number, using ${fallback}`, v);
    return fallback;
  }
  return Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
}

/** Like `number`, rounded down. */
export function int(value: string | undefined, options: NumberOptions): number {
  return Math.floor(number(value, options));
}

/** A normalised absolute http(s) URL without trailing slashes, or undefined (an invalid one also records an issue). */
export function url(value: string | undefined, name?: string): string | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  try {
    const parsed = new URL(v);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol');
    return v.replace(/\/+$/, '');
  } catch {
    record(name, 'expected an http(s) URL, ignoring it', v);
    return undefined;
  }
}

export const envString = (name: string): string | undefined => process.env[name]?.trim() || undefined;
export const envFlag = (name: string, fallback: boolean): boolean => flag(process.env[name], fallback, name);
export const envNumber = (name: string, options: Omit<NumberOptions, 'name'>): number => number(process.env[name], { ...options, name });
export const envInt = (name: string, options: Omit<NumberOptions, 'name'>): number => int(process.env[name], { ...options, name });
export const envUrl = (name: string): string | undefined => url(process.env[name], name);
