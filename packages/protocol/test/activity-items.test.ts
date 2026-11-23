/** The activity item schema compiles, and every expected output in the shared cases (activity-items/cases.json) is valid against it. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'activity-items');
const read = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const schema = read('activity-item.schema.json');
const fixture = read('cases.json') as { cases: Array<{ id: string; output?: unknown }> };

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

describe('activity item schema', () => {
  const validate = addFormats(new Ajv2020({ strict: true, allErrors: true })).compile(schema);
  for (const c of fixture.cases.filter((x) => x.output)) {
    it(`accepts the output of ${c.id}`, () => {
      expect(validate(expand(c.output)), JSON.stringify(validate.errors)).toBe(true);
    });
  }
  it('rejects an extra field and a bad kind', () => {
    const ok = expand(fixture.cases[0].output) as Record<string, unknown>;
    expect(validate({ ...ok, extra: 1 })).toBe(false);
    expect(validate({ ...ok, kind: 'Work Discussion' })).toBe(false);
  });
});
