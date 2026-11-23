/**
 * C28 T-2: the sampled profile (memory/sample.ts): every static fact, plus at most N dynamic ones chosen by weighted
 * buckets (recent, confident, often revised, old, inferred), rendered as Markdown inside a token budget (AS-6).
 */
import { describe, expect, it } from 'vitest';
import type { MemoryItem } from '@/lib/shared/memory';
import { profileMarkdown, sampleProfile } from '@/lib/server/memory/sample';

const NOW = new Date('2026-11-20T00:00:00Z');
const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();

/** 60 static and 340 dynamic items; every dynamic one has its own age, so each bucket has an unambiguous order. */
function corpus(): MemoryItem[] {
  const items: MemoryItem[] = [];
  for (let n = 0; n < 60; n++) items.push({ id: `s${n}`, text: `Static fact ${n}`, kind: 'memory', source: 'fact', static: true, evidenceCount: n % 7, confidence: 1, origin: 'person', createdAt: at(400 + n), updatedAt: at(400 + n) });
  for (let n = 0; n < 340; n++) {
    items.push({
      id: `d${n}`,
      text: `Dynamic fact number ${n} about the payments team and what changed during the quarter, with owners, dates and the reasons behind each decision`,
      kind: 'memory',
      source: 'fact',
      version: n % 4 === 0 ? 3 : 1, // every fourth was revised
      confidence: n % 5 === 0 ? 0.99 : n % 3 === 0 ? 0.5 : 0.9,
      origin: n % 3 === 0 ? 'landflow' : 'person',
      createdAt: at(1 + n * 2),
      updatedAt: at(1 + n),
    });
  }
  return items;
}

describe('sampleProfile', () => {
  it('keeps every static fact and at most 60 dynamic ones (AS-6)', () => {
    const sampled = sampleProfile(corpus(), {});
    expect(sampled.static).toHaveLength(60);
    expect(sampled.dynamic).toHaveLength(60);
    expect(sampled.left).toBe(340 - 60);
    expect(new Set(sampled.dynamic.map((i) => i.id)).size).toBe(60); // no repeats across buckets
  });

  it('ranks static facts by how many sources back them', () => {
    const { static: list } = sampleProfile(corpus(), {});
    const counts = list.map((i) => i.evidenceCount ?? 0);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  it('ranks a person’s static facts before extracted ones, whatever their evidence counts', () => {
    const mk = (id: string, origin: 'person' | 'landflow', evidenceCount: number): MemoryItem => ({ id, text: id, kind: 'memory', source: 'fact', static: true, origin, evidenceCount, createdAt: at(1), updatedAt: at(1) });
    const { static: list } = sampleProfile([mk('extracted-5', 'landflow', 5), mk('person-0', 'person', 0), mk('extracted-9', 'landflow', 9), mk('person-2', 'person', 2)]);
    expect(list.map((i) => i.id)).toEqual(['person-2', 'person-0', 'extracted-9', 'extracted-5']);
  });

  it('counts distinct executions and documents, not evidence rows', () => {
    const mk = (id: string, sourceCount: number, evidenceCount: number): MemoryItem => ({ id, text: id, kind: 'memory', source: 'fact', static: true, origin: 'landflow', sourceCount, evidenceCount, createdAt: at(1), updatedAt: at(1) });
    const { static: list } = sampleProfile([mk('many-rows', 1, 6), mk('many-sources', 3, 3)]);
    expect(list.map((i) => i.id)).toEqual(['many-sources', 'many-rows']);
  });

  it('falls back to the defaults for a size that is not a finite number, and clamps it to 1..500', () => {
    const items = corpus();
    expect(sampleProfile(items, { size: Number.NaN }).dynamic).toHaveLength(60);
    expect(sampleProfile(items, { size: Number.POSITIVE_INFINITY }).dynamic).toHaveLength(60);
    expect(sampleProfile(items, { size: 0 }).dynamic).toHaveLength(1);
    expect(sampleProfile(items, { size: 10_000 }).dynamic).toHaveLength(340); // 500 is more than the 340 there are
  });

  it('fills the buckets in order with 35 / 25 / 15 / 5 / 10 percent, the rest from the newest left', () => {
    const sampled = sampleProfile(corpus(), {});
    // floor(60 * w): 21 recent, 15 confident, 9 revised, 3 old, 6 inferred, then the 6 short of 60 from the most recent left
    expect(sampled.buckets).toEqual({ recent: 21, confident: 15, revised: 9, old: 3, inferred: 6, rest: 6 });
    const ids = new Set(sampled.dynamic.map((i) => i.id));
    for (let n = 0; n < 21; n++) expect(ids.has(`d${n}`), `recent d${n}`).toBe(true); // the 21 newest
    expect(ids.has('d339')).toBe(true); // the oldest is in the "old" bucket
    expect(sampled.dynamic.filter((i) => (i.version ?? 1) > 1).length).toBeGreaterThanOrEqual(9);
  });

  it('takes the size and the weights from its options, and a shortage moves to the newest left', () => {
    const sampled = sampleProfile(corpus(), { size: 10, weights: { recent: 1, confident: 0, revised: 0, old: 0, inferred: 0 } });
    expect(sampled.dynamic.map((i) => i.id)).toEqual(Array.from({ length: 10 }, (_, n) => `d${n}`));
    const few = sampleProfile(corpus().slice(0, 65), {}); // 60 static + 5 dynamic: nothing to cut
    expect(few.dynamic).toHaveLength(5);
    expect(few.left).toBe(0);
  });

  it('only calls a fact inferred when Landflow wrote it with confidence under 0.8 (C28-D11)', () => {
    const items: MemoryItem[] = [
      { id: 'a', text: 'A', kind: 'memory', source: 'fact', origin: 'landflow', confidence: 0.5, createdAt: at(5), updatedAt: at(5) },
      { id: 'b', text: 'B', kind: 'memory', source: 'fact', origin: 'person', confidence: 0.5, createdAt: at(4), updatedAt: at(4) },
      { id: 'c', text: 'C', kind: 'memory', source: 'fact', origin: 'landflow', confidence: 0.95, createdAt: at(3), updatedAt: at(3) },
    ];
    const sampled = sampleProfile(items, { size: 1, weights: { recent: 0, confident: 0, revised: 0, old: 0, inferred: 1 } });
    expect(sampled.dynamic.map((i) => i.id)).toEqual(['a']);
  });

  it('gives the same answer for the same input, in any input order', () => {
    const items = corpus();
    const first = sampleProfile(items, {});
    const second = sampleProfile([...items].reverse(), {});
    expect(second.dynamic.map((i) => i.id).sort()).toEqual(first.dynamic.map((i) => i.id).sort());
    expect(second.static.map((i) => i.id)).toEqual(first.static.map((i) => i.id));
    expect(profileMarkdown(second).markdown).toBe(profileMarkdown(first).markdown);
  });
});

describe('profileMarkdown', () => {
  it('fits the token budget (4 characters a token) and says how many were left out', () => {
    const sampled = sampleProfile(corpus(), {});
    const out = profileMarkdown(sampled, 1_500);
    expect(out.tokens).toBeLessThanOrEqual(1_500);
    expect(Math.ceil(out.markdown.length / 4)).toBeLessThanOrEqual(1_500);
    expect(out.left).toBeGreaterThan(sampled.left); // the budget cut some of the sample as well
    expect(out.markdown.trimEnd().endsWith(`_${out.left} more not shown_`)).toBe(true);
    expect(out.markdown.startsWith('## ')).toBe(true);
    expect(out.markdown).toContain('Static fact 0'); // static first
  });

  it('uses the default budget for one that is not a finite number, and clamps it to 100..20,000', () => {
    const sampled = sampleProfile(corpus());
    expect(profileMarkdown(sampled, Number.NaN).tokens).toBeLessThanOrEqual(1_500);
    expect(profileMarkdown(sampled, 5).tokens).toBeLessThanOrEqual(100);
    expect(profileMarkdown(sampled, 5).tokens).toBeGreaterThan(50);
    expect(profileMarkdown(sampled, 1e9).tokens).toBeLessThanOrEqual(20_000);
  });

  it('lists everything and says nothing about omissions when it all fits', () => {
    const out = profileMarkdown({ static: [{ id: 's', text: 'Always true', kind: 'memory', source: 'fact', static: true, createdAt: at(1), updatedAt: at(1) }], dynamic: [], left: 0 }, 1_500);
    expect(out.left).toBe(0);
    expect(out.markdown).toContain('- Always true');
    expect(out.markdown).not.toMatch(/not shown/);
  });

  it('puts the newest dynamic facts first', () => {
    const out = profileMarkdown(sampleProfile(corpus(), { size: 3, weights: { recent: 1, confident: 0, revised: 0, old: 0, inferred: 0 } }), 1_500);
    expect(out.markdown.indexOf('number 0 ')).toBeLessThan(out.markdown.indexOf('number 2 '));
  });
});
