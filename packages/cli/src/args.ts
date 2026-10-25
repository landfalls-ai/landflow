/**
 * A small argument parser: `--flag value`, `--flag=value`, `-f value`, boolean flags, repeatable flags, `--` to end
 * the flags, and `-` as a positional (stdin). Flags are declared per command; an unknown flag is a usage error.
 */
import { usage } from './errors';

export interface FlagSpec {
  type: 'string' | 'boolean' | 'number';
  description: string;
  short?: string;
  /** Repeatable: the value is an array. */
  multiple?: boolean;
  /** Shown in help: `--dir <path>`. */
  placeholder?: string;
}

export type FlagSpecs = Record<string, FlagSpec>;
export type FlagValues = Record<string, string | number | boolean | string[] | undefined>;

export interface Parsed {
  positionals: string[];
  flags: FlagValues;
}

/** Parse `tokens` against `specs`. */
export function parseArgs(tokens: string[], specs: FlagSpecs): Parsed {
  const positionals: string[] = [];
  const flags: FlagValues = {};
  const byShort = new Map(Object.entries(specs).flatMap(([name, spec]) => (spec.short ? [[spec.short, name] as const] : [])));

  const set = (name: string, spec: FlagSpec, raw: string | undefined) => {
    let value: string | number | boolean;
    if (spec.type === 'boolean') {
      if (raw === undefined) value = true;
      else if (/^(true|1|yes)$/i.test(raw)) value = true;
      else if (/^(false|0|no)$/i.test(raw)) value = false;
      else throw usage(`--${name} takes no value (or true/false), got "${raw}"`);
    } else {
      if (raw === undefined) throw usage(`--${name} needs a value${spec.placeholder ? ` (${spec.placeholder})` : ''}`);
      if (spec.type === 'number') {
        value = Number(raw);
        if (!Number.isFinite(value)) throw usage(`--${name} must be a number, got "${raw}"`);
      } else value = raw;
    }
    if (spec.multiple) flags[name] = [...((flags[name] as string[] | undefined) ?? []), String(value)];
    else flags[name] = value;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--') {
      positionals.push(...tokens.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq >= 0 ? token.slice(2, eq) : token.slice(2);
      const spec = specs[name];
      if (!spec) throw usage(`Unknown option --${name}`);
      let raw = eq >= 0 ? token.slice(eq + 1) : undefined;
      if (raw === undefined && spec.type !== 'boolean') {
        raw = tokens[i + 1];
        if (raw === undefined || (raw.startsWith('--') && raw.length > 2)) throw usage(`--${name} needs a value${spec.placeholder ? ` (${spec.placeholder})` : ''}`);
        i++;
      }
      set(name, spec, raw);
      continue;
    }
    if (token.startsWith('-') && token.length > 1) {
      const name = byShort.get(token.slice(1, 2));
      if (!name || (token.length > 2 && specs[name].type === 'boolean')) throw usage(`Unknown option ${token}`);
      const spec = specs[name];
      let raw = token.length > 2 ? token.slice(2) : undefined;
      if (raw === undefined && spec.type !== 'boolean') {
        raw = tokens[i + 1];
        if (raw === undefined) throw usage(`-${spec.short} needs a value`);
        i++;
      }
      set(name, spec, raw);
      continue;
    }
    positionals.push(token);
  }
  return { positionals, flags };
}

/** One help line per flag, aligned. */
export function describeFlags(specs: FlagSpecs): string {
  const rows = Object.entries(specs).map(([name, spec]) => {
    const left = `${spec.short ? `-${spec.short}, ` : '    '}--${name}${spec.type === 'boolean' ? '' : ` <${spec.placeholder ?? spec.type}>`}`;
    return [left, spec.description + (spec.multiple ? ' (repeatable)' : '')];
  });
  const width = Math.max(0, ...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`).join('\n');
}
