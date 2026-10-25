/**
 * Variables (Settings → Variables): instance-wide key/value strings that
 * expressions read as `$vars.NAME`, kept in <data dir>/variables.json. The
 * runner reads them fresh for every run; the Code node and agent node tools
 * see the same values. Read-only inside workflows.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Variable } from '../shared/platform';
import { atomicWrite, store } from './store';

export type { Variable };

/** n8n's rule: a letter or underscore, then letters, digits and underscores. */
export const VARIABLE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_KEY_LENGTH = 64;
export const MAX_VALUE_LENGTH = 10_000;
export const MAX_VARIABLES = 500;

interface StoredVariable extends Variable {
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

/** Variables backed by one JSON file, read on every call. The default instance lives in the data directory; tests make their own. */
export class VariableFile {
  constructor(readonly path: string) {}

  private read(): StoredVariable[] {
    try {
      const saved = JSON.parse(readFileSync(this.path, 'utf8')) as { variables?: StoredVariable[] };
      return (saved.variables ?? []).filter((v) => typeof v?.key === 'string' && typeof v.value === 'string');
    } catch {
      return [];
    }
  }

  private write(list: StoredVariable[]) {
    atomicWrite(this.path, { version: 1, variables: list.sort((a, b) => a.key.localeCompare(b.key)) });
  }

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
    list.push({ key, value, createdAt: now, updatedAt: now });
    this.write(list);
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
    this.write(list);
    return { key: nextKey, value };
  }

  delete(key: string): boolean {
    const list = this.read();
    const next = list.filter((v) => v.key !== key);
    if (next.length === list.length) return false;
    this.write(next);
    return true;
  }
}

/** The instance's variables (<data dir>/variables.json). */
export const variables = {
  file: () => new VariableFile(join(store.dir, 'variables.json')),
  list: () => variables.file().list(),
  record: () => variables.file().record(),
  get: (key: string) => variables.file().get(key),
  create: (input: { key: string; value: unknown }) => variables.file().create(input),
  update: (key: string, patch: { key?: string; value?: unknown }) => variables.file().update(key, patch),
  delete: (key: string) => variables.file().delete(key),
};
