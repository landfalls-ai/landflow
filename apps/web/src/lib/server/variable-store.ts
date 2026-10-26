/**
 * The rules of variables (key syntax, value length, how many) over a storage that is read on every call: the
 * instance's (./variables.ts), a project's (./projects/variables.ts) or a JSON file (the format older versions used;
 * tests use it too).
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { Variable } from '../shared/platform';

export type { Variable };

/** n8n's rule: a letter or underscore, then letters, digits and underscores. */
export const VARIABLE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_KEY_LENGTH = 64;
export const MAX_VALUE_LENGTH = 10_000;
export const MAX_VARIABLES = 500;

export interface StoredVariable extends Variable {
  createdAt: string;
  updatedAt: string;
}

export class VariableError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function checkKey(key: string) {
  if (!key) throw new VariableError('Enter a key');
  if (key.length > MAX_KEY_LENGTH) throw new VariableError(`Keys are at most ${MAX_KEY_LENGTH} characters`);
  if (!VARIABLE_KEY.test(key)) throw new VariableError('Keys start with a letter or "_" and contain only letters, digits and "_"');
}

function checkValue(value: unknown): string {
  if (typeof value !== 'string') throw new VariableError('Values are strings');
  if (value.length > MAX_VALUE_LENGTH) throw new VariableError(`Values are at most ${MAX_VALUE_LENGTH.toLocaleString('en-US')} characters`);
  return value;
}

/** What changed in a write: the variable saved (under its new key) and the key that went away (a delete or a rename). */
export interface VariableChange {
  saved?: StoredVariable;
  removed?: string;
}

/** The variable rules over a storage that is read on every call (a JSON file or the database). */
export abstract class VariableStore {
  protected abstract read(): StoredVariable[];
  protected abstract write(list: StoredVariable[], change: VariableChange): void;

  /** `[{ key, value }]`, sorted by key. */
  list(): Variable[] {
    return this.read()
      .map(({ key, value }) => ({ key, value }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /** `{ NAME: value }`, what `$vars` sees. */
  record(): Record<string, string> {
    return Object.fromEntries(this.read().map((v) => [v.key, v.value]));
  }

  get(key: string): Variable | undefined {
    const found = this.read().find((v) => v.key === key);
    return found && { key: found.key, value: found.value };
  }

  create(input: { key: string; value: unknown }): Variable {
    const key = input.key.trim();
    checkKey(key);
    const value = checkValue(input.value);
    const list = this.read();
    if (list.some((v) => v.key === key)) throw new VariableError(`A variable named ${key} already exists`, 409);
    if (list.length >= MAX_VARIABLES) throw new VariableError(`At most ${MAX_VARIABLES} variables`);
    const now = new Date().toISOString();
    const saved = { key, value, createdAt: now, updatedAt: now };
    list.push(saved);
    this.write(list, { saved });
    return { key, value };
  }

  /** Change the value and/or rename the key. */
  update(key: string, patch: { key?: string; value?: unknown }): Variable {
    const list = this.read();
    const index = list.findIndex((v) => v.key === key);
    if (index < 0) throw new VariableError(`Variable ${key} not found`, 404);
    const nextKey = patch.key === undefined ? key : patch.key.trim();
    if (nextKey !== key) {
      checkKey(nextKey);
      if (list.some((v) => v.key === nextKey)) throw new VariableError(`A variable named ${nextKey} already exists`, 409);
    }
    const value = patch.value === undefined ? list[index].value : checkValue(patch.value);
    list[index] = { ...list[index], key: nextKey, value, updatedAt: new Date().toISOString() };
    this.write(list, { saved: list[index], ...(nextKey !== key && { removed: key }) });
    return { key: nextKey, value };
  }

  delete(key: string): boolean {
    const list = this.read();
    const next = list.filter((v) => v.key !== key);
    if (next.length === list.length) return false;
    this.write(next, { removed: key });
    return true;
  }
}

/** Variables backed by one JSON file. */
export class VariableFile extends VariableStore {
  constructor(readonly path: string) {
    super();
  }

  protected read(): StoredVariable[] {
    try {
      const saved = JSON.parse(readFileSync(this.path, 'utf8')) as { variables?: StoredVariable[] };
      return (saved.variables ?? []).filter((v) => typeof v?.key === 'string' && typeof v.value === 'string');
    } catch {
      return [];
    }
  }

  protected write(list: StoredVariable[]) {
    const tmp = `${this.path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, variables: list.sort((a, b) => a.key.localeCompare(b.key)) }, null, 2));
    renameSync(tmp, this.path);
  }
}
