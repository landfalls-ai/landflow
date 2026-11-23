/** activityItem against the cases shared with the Go and Python SDKs, and its schema against the published JSON Schema (packages/protocol checks the cases' outputs against it). */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACTIVITY_ITEM_SCHEMA, activityItem, clipText, type ActivityInput } from '../src/activity';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'protocol', 'activity-items');
const read = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const schemaFile = read('activity-item.schema.json');
const fixture = read('cases.json') as { kit: string; cases: Array<{ id: string; input: unknown; output?: unknown; error?: string }> };

/** `{{repeat:c:n}}rest` is c n times then rest; `{{range:n}}` is [0, …, n-1]. */
function expand(value: unknown): unknown {
  if (typeof value === 'string') {
    const repeat = /^\{\{repeat:(.):(\d+)\}\}(.*)$/su.exec(value);
    if (repeat) return repeat[1].repeat(Number(repeat[2])) + repeat[3];
    const range = /^\{\{range:(\d+)\}\}$/.exec(value);
    if (range) return Array.from({ length: Number(range[1]) }, (_, i) => i);
    return value;
  }
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)]));
  return value;
}

describe('activity items', () => {
  it('declares the published schema', () => {
    expect(fixture.kit).toBe('landflow.activity-items/v1');
    expect(ACTIVITY_ITEM_SCHEMA.properties).toEqual(schemaFile.properties);
    expect(ACTIVITY_ITEM_SCHEMA.required).toEqual(schemaFile.required);
    expect(ACTIVITY_ITEM_SCHEMA.additionalProperties).toBe(false);
  });

  for (const c of fixture.cases) {
    it(`case ${c.id}`, () => {
      const input = expand(c.input) as ActivityInput;
      if (c.error) {
        expect(() => activityItem(input)).toThrow(c.error);
        return;
      }
      const item = activityItem(input);
      expect(item).toEqual(expand(c.output));
    });
  }

  it('clips by characters, not UTF-16 units', () => {
    expect(clipText('😀😀😀', 2)).toBe('😀…');
    expect(clipText('abc', 3)).toBe('abc');
  });

  it('accepts a Date', () => {
    expect(activityItem({ source: 's', sourceId: 'i', kind: 'work.x', occurredAt: new Date(Date.UTC(2026, 10, 12)) }).occurredAt).toBe('2026-11-12T00:00:00.000Z');
  });
});
