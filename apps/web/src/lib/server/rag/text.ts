import type { JsonObject, JsonValue } from '@landflow/sdk';

const scalar = (value: JsonValue) => (typeof value === 'string' ? value : JSON.stringify(value));

/** A JSON value as readable text: strings as they are, objects as `key: value` lines (nested values as JSON). */
export function textOf(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || Array.isArray(value)) return JSON.stringify(value);
  return Object.entries(value as JsonObject)
    .filter(([, entry]) => entry !== undefined && entry !== null && entry !== '')
    .map(([key, entry]) => `${key}: ${scalar(entry)}`)
    .join('\n');
}
