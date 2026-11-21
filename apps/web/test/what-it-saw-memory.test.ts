/**
 * Memory on "What it saw" (C11, docs/run-trace.md#what-it-saw): the `saw.memory` / `saw.memoryText` attributes and what
 * each trace content mode keeps of them, read back from the journal's stored row.
 */
import { describe, expect, it } from 'vitest';
import type { JournalEvent } from '@/lib/shared/run-trace';
import { SAW_MEMORY_MAX_ITEMS, type SawAttrs, type SawMemorySource } from '@/lib/shared/what-it-saw';
import { applyContent } from '@/lib/server/journal/content';

const items = (n: number, prefix = 'm') => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, version: i + 1, kind: 'fact', static: i < 3, score: 0.5 }));
const memory = (): SawMemorySource[] => [
  { source: 'agent-profile', count: 3, items: items(3), hash: 'a'.repeat(16) },
  { source: 'agent-relevant', mode: 'meaning', count: 2, items: items(2, 'r'), hash: 'b'.repeat(16) },
];
const saw = (extra: Partial<SawAttrs> = {}): SawAttrs => ({ mode: 'off', text: '', at: '2026-11-21T00:00:00Z', persona: {}, practices: [], memory: memory(), memoryText: '<landflow-memory>secret fact</landflow-memory>', ...extra });
const span = (s: SawAttrs): JournalEvent => ({ type: 'span.started', seq: 1, executionId: 'e', at: 'a', spanId: 's', kind: 'agent', name: 'A', actor: { id: 'a', name: 'A', type: 'agent' }, attrs: { saw: s } } as JournalEvent);
// The stored row is the JSON of the event applyContent returns.
const stored = (s: SawAttrs, mode: 'full' | 'summaries' | 'off') => (JSON.parse(JSON.stringify(applyContent(span(s), mode))) as { attrs: { saw: SawAttrs } }).attrs.saw;

describe('saw memory by content mode', () => {
  it('full keeps memory and the exact text', () => {
    const row = stored(saw(), 'full');
    expect(row.memory).toHaveLength(2);
    expect(row.memoryText).toContain('secret fact');
  });

  it('summaries keeps ids, versions, kinds, scores and hash, and no text', () => {
    const row = stored(saw(), 'summaries');
    expect(row.memoryText).toBeUndefined();
    expect(row.memory?.[1]).toMatchObject({ source: 'agent-relevant', mode: 'meaning', count: 2, hash: 'b'.repeat(16) });
    expect(row.memory?.[1].items[0]).toEqual({ id: 'r0', version: 1, kind: 'fact', static: true, score: 0.5 });
    expect(JSON.stringify(row)).not.toContain('secret fact');
  });

  it('off stores neither memory nor text', () => {
    const row = stored(saw(), 'off');
    expect(row.memory).toBeUndefined();
    expect(row.memoryText).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain('secret fact');
    expect(row).toMatchObject({ withheld: true });
  });

  it('cuts a source over the item limit and keeps its real count', () => {
    const big = saw({ memory: [{ source: 'team-notebook', count: 60, items: items(60, 'n') }] });
    for (const mode of ['full', 'summaries'] as const) {
      const src = stored(big, mode).memory?.[0];
      expect(src?.items).toHaveLength(SAW_MEMORY_MAX_ITEMS);
      expect(src?.count).toBe(60);
    }
  });

  it('leaves a saw without memory alone', () => {
    const row = stored(saw({ memory: undefined, memoryText: undefined }), 'summaries');
    expect(row.memory).toBeUndefined();
  });
});
