/**
 * Join test (wave 12, carryover §2, `spend-bpe-join`): SP22's TypeScript byte-level BPE and `hashParts` ↔ SP21's Python
 * counter and `hash_segments` in the gateway's callback, run in the pinned LiteLLM image. Each package tested its side
 * against the shared fixture; here both sides count the same strings (the fixture's cases and 200 seeded ones: whitespace
 * runs, digits, non-ASCII, emoji) and hash the same segments under the same key bytes, and must agree exactly.
 *
 * The fixture copies are compared always (offline); the image runs only with LANDFLOW_INTEGRATION=gateway-image.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DraftSegment } from '@/lib/server/ai-usage/call-context';
import { GATEWAY_IMAGE, PY_HEADER, REPO_ROOT, gatewayImageEnabled, runInGatewayImage } from './gateway-image';

vi.setConfig({ testTimeout: 240_000 });

const { ByteLevelBpe } = await import('@/lib/server/ai-usage/count/ollama-bpe');
const { hashParts } = await import('@/lib/server/ai-usage/parts');

const OWNER = join(REPO_ROOT, 'apps', 'web', 'test', 'fixtures', 'bpe-fixture.json');
const COPY = join(REPO_ROOT, 'deploy', 'llm-gateway', 'tests', 'bpe-fixture.json');
const fixture = JSON.parse(readFileSync(OWNER, 'utf8')) as { pre: string; tokens: string[]; merges: string[]; cases: { text: string; count: number }[] };

/** 200 strings from a fixed seed: pieces that stress the pre-tokenizer and the byte fallback. */
function seededStrings(n = 200): string[] {
  let seed = 20261116;
  const rand = (k: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % k;
  };
  const pieces = [
    'the', ' the', 'Hello', ', ', 'world', '!', ' ', '  ', '   ', '\t', '\n', '\n\n', '\r\n', ' \n ', '0', '7', '42', '12345', '3.14', '1,000',
    'café', 'naïve', 'ünïcödé', 'Ünïcode', '—', '–', '…', '日本語', 'Привет', 'עברית', 'مرحبا', '☕', '😀', '👩‍💻', '🇮🇱', ' ', 'tokens', ' digits',
    "'s", "'ll", "'RE", "don't", 'x=y+1;', '{"a":[1,2]}', '<tag/>', '#!', '__init__', 'CamelCaseWord', 'snake_case', 'a', 'b', 'c',
  ];
  return Array.from({ length: n }, () => Array.from({ length: 1 + rand(12) }, () => pieces[rand(pieces.length)]).join(''));
}

/** One prompt's segments in the order the adapter sends them, a breakpoint after the tools and the stable system part. */
const SEGMENTS: DraftSegment[] = [
  { where: 'tools', part: 'toolDefinitions', text: '{"name":"read_file","description":"Reads a file — naïve","input_schema":{"type":"object"}}' },
  { where: 'tools', part: 'toolDefinitions', text: '{"name":"bash","description":"Runs 1 command 👩‍💻","input_schema":{"type":"object"}}', breakpoint: true },
  { where: 'system', part: 'instructions', text: 'You are a careful agent.\n\n' },
  { where: 'system', part: 'projectBlock', text: '## Where this work fits\nProject Ünïcode' },
  { where: 'system', part: 'practices', text: '\n\n## Practices\n- use helm', breakpoint: true },
  { where: 'system', part: 'memory', text: '\n\n## What you remember about this user\n- likes tea ☕' },
  { where: 'system', part: 'formatting', text: ' Current date and time: 2026-11-16T10:00:00.000Z.' },
  { where: 'messages', part: 'history', text: 'earlier turn' },
  { where: 'messages', part: 'toolResults', text: 'file contents\n\t12345' },
  { where: 'messages', part: 'history', text: 'second turn' },
  { where: 'messages', part: 'userMessage', text: 'Now fix the bug — 日本語' },
];

const SCRIPT = `${PY_HEADER}
counter = cc.BpeCounter(INPUT["fixture"]["tokens"], INPUT["fixture"]["merges"], INPUT["fixture"]["pre"])
key = bytes.fromhex(INPUT["key"])
hashes = [cc.hash_segments(c["segments"], c["images"], key, c["toolNames"]) for c in INPUT["hashCases"]]
print(json.dumps({"counts": [counter.count(t) for t in INPUT["texts"]], "hashes": hashes}))
`;

describe('spend-bpe-join: the TypeScript and Python counters and hashes agree', () => {
  it('the gateway’s fixture is a byte-identical copy of SP22’s', () => {
    expect(readFileSync(COPY).equals(readFileSync(OWNER))).toBe(true);
    expect(readFileSync(join(REPO_ROOT, 'deploy', 'compose.infra.yml'), 'utf8')).toContain(GATEWAY_IMAGE);
  });

  it.skipIf(!gatewayImageEnabled)('count every fixture case and 200 seeded strings alike, and hash one prompt alike under one key', () => {
    const bpe = new ByteLevelBpe(fixture);
    const texts = [...fixture.cases.map((c) => c.text), ...seededStrings()];
    const key = randomBytes(32);
    const hashCases = [
      { segments: SEGMENTS, images: 2, toolNames: ['read_file', 'bash'] },
      // No breakpoint: the prefix is the tools and the system segments.
      { segments: SEGMENTS.map(({ breakpoint: _b, ...s }) => s), images: 0, toolNames: [] },
      // A breakpoint on a message (neither side's drafts mark one today): both cut the prefix there alike.
      { segments: SEGMENTS.map(({ breakpoint: _b, ...s }, i) => (i === SEGMENTS.length - 1 ? { ...s, breakpoint: true } : s)), images: 0, toolNames: [] },
    ];
    const python = runInGatewayImage<{ counts: number[]; hashes: Array<Record<string, unknown>> }>(SCRIPT, { fixture, texts, key: key.toString('hex'), hashCases });

    // The fixture's reference counts, both sides.
    fixture.cases.forEach((c, i) => {
      expect(bpe.count(c.text), JSON.stringify(c.text)).toBe(c.count);
      expect(python.counts[i], JSON.stringify(c.text)).toBe(c.count);
    });
    // The seeded strings: whatever the count, the same on both sides.
    const mismatches = texts.map((t, i) => [t, bpe.count(t), python.counts[i]] as const).filter(([, ts, py]) => ts !== py);
    expect(mismatches).toEqual([]);
    expect(python.counts).toHaveLength(texts.length);

    // The hashes: Landflow's hashParts and the callback's hash_segments, the same key bytes.
    hashCases.forEach((c, i) => {
      const ts = hashParts({ segments: c.segments, images: c.images, ...(c.toolNames.length && { toolNames: c.toolNames }) }, key);
      expect(python.hashes[i]!.partHashes, `case ${i}`).toEqual(ts.partHashes);
      expect(python.hashes[i]!.promptHash, `case ${i}`).toBe(ts.promptHash);
      expect(python.hashes[i]!.prefixHash, `case ${i}`).toBe(ts.prefixHash);
      expect(python.hashes[i]!.toolNames ?? undefined, `case ${i}`).toEqual(ts.toolNames);
    });
    // The date line (a `formatting` segment) is in no part hash, on either side.
    expect(Object.keys(python.hashes[0]!.partHashes as object)).not.toContain('formatting');
    // The cache points matter: the marked prefix differs from the unmarked one.
    expect(python.hashes[0]!.prefixHash).not.toBe(python.hashes[1]!.prefixHash);
  });
});
