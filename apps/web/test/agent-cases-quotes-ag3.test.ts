/**
 * Wave ag3 carryover (the live pass, utility agent): a design's case read `Hash "password` because the case parser took a
 * quote off each end of the input whether or not it wrapped the whole text. Quotes come off only when they wrap it.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-cases-quotes-ag3-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
const { parseCases, unwrapQuotes } = await import('@/lib/server/assistant/architect');

describe("a case's quotes", () => {
  it('a quote inside the text stays; a wrapping pair goes', () => {
    expect(parseCases('Hash "password" => The SHA-256 of password\n"Give me a UUID" => A v4 UUID\n“Slugify it” => a-slug')).toEqual([
      { input: 'Hash "password"', expected: 'The SHA-256 of password' },
      { input: 'Give me a UUID', expected: 'A v4 UUID' },
      { input: 'Slugify it', expected: 'a-slug' },
    ]);
    expect(unwrapQuotes('"a" and "b"')).toBe('"a" and "b"');
    expect(unwrapQuotes("'one'")).toBe('one');
  });
});
