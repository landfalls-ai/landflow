/**
 * Field paths shared by the data nodes, n8n-style: "user.address.city" and
 * "items[0].name" reach into nested values. A key that exists literally on the
 * object ("user.email" as one key) wins over the path, and `dotNotation: false`
 * (n8n's "Disable Dot Notation") always reads the key literally.
 */
import { NodeOperationError } from '@landflow/sdk';

type Bag = Record<string, unknown>;

const isBag = (value: unknown): value is Bag => typeof value === 'object' && value !== null;

/** "a.b[0].c" → ["a", "b", "0", "c"]. */
export function splitPath(path: string): string[] {
  return path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((key) => key !== '');
}

export function getPath(source: unknown, path: string, dotNotation = true): unknown {
  if (!isBag(source)) return undefined;
  if (!dotNotation || path in source) return source[path];
  let cursor: unknown = source;
  for (const key of splitPath(path)) {
    if (!isBag(cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

export function hasPath(source: unknown, path: string, dotNotation = true): boolean {
  if (!isBag(source)) return false;
  if (!dotNotation || path in source) return path in source;
  const keys = splitPath(path);
  let cursor: unknown = source;
  for (const key of keys) {
    if (!isBag(cursor) || !(key in cursor)) return false;
    cursor = cursor[key];
  }
  return keys.length > 0;
}

/** Set a value, creating intermediate objects. */
export function setPath(target: Bag, path: string, value: unknown, dotNotation = true) {
  if (!dotNotation) {
    target[path] = value;
    return;
  }
  const keys = splitPath(path);
  if (!keys.length) return;
  let cursor = target;
  keys.slice(0, -1).forEach((key) => {
    if (!isBag(cursor[key])) cursor[key] = {};
    cursor = cursor[key] as Bag;
  });
  cursor[keys[keys.length - 1]] = value;
}

/** Remove a value; returns whether something was removed. */
export function unsetPath(target: Bag, path: string, dotNotation = true): boolean {
  if (!dotNotation || path in target) return delete target[path];
  const keys = splitPath(path);
  let cursor: unknown = target;
  for (const key of keys.slice(0, -1)) {
    if (!isBag(cursor)) return false;
    cursor = cursor[key];
  }
  const last = keys[keys.length - 1];
  if (!isBag(cursor) || last === undefined || !(last in cursor)) return false;
  if (Array.isArray(cursor)) cursor.splice(Number(last), 1);
  else delete cursor[last];
  return true;
}

/**
 * A field name as typed or dropped into a field-name parameter (these are
 * `noDataExpression`, so a dragged `{{ $json.user.email }}` arrives as text).
 */
export function cleanField(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/^=?\{\{\s*\$json\.([\w.[\]$-]+)\s*\}\}$/, '$1')
    .replace(/^\$json\./, '');
}

/** A comma-separated list of field names ("id, user.email") as n8n's data nodes take them. */
export function fieldList(value: unknown, label = 'Fields'): string[] {
  const raw = Array.isArray(value) ? value.map(String) : String(value ?? '').split(',');
  const fields = raw.map(cleanField);
  if (fields.some((field) => field === '') && fields.length > 1)
    throw new NodeOperationError(`${label}: a field name is empty`, { description: 'Check for a stray comma.' });
  return fields.filter(Boolean);
}

/** JSON with sorted keys, so equal objects compare equal whatever their key order. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (!isBag(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

export const isEmptyValue = (value: unknown) => value === undefined || value === null || value === '';
