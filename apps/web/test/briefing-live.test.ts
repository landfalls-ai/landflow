/**
 * Write Briefing with a real model (opt-in):
 *   LANDFLOW_INTEGRATION=ollama npx vitest run test/briefing-live.test.ts
 * OLLAMA_URL picks the server (default http://127.0.0.1:11434); LANDFLOW_OLLAMA_CHAT_MODEL the model. The briefing stays within
 * 1,200 characters. The model is given the person's allowed items only; what it never sees is covered in briefing-nodes.test.ts.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { GatheredWork } from '@/lib/shared/brain-work';

const enabled = process.env.LANDFLOW_INTEGRATION?.split(',').includes('ollama');
const baseUrl = (process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
const chatModel = process.env.LANDFLOW_OLLAMA_CHAT_MODEL ?? 'qwen3-coder:30b';

vi.setConfig({ testTimeout: 180_000 });

describe.skipIf(!enabled)('Write Briefing on Ollama', () => {
  it('writes at most 1,200 characters from the gathered work alone', async () => {
    process.env.LANDFLOW_DATA_DIR = mkdtempSync(join(tmpdir(), 'landflow-briefing-live-'));
    const { writeBriefingText } = await import('@/lib/server/brain/briefing');
    process.env.OLLAMA_URL = baseUrl;
    const { assistantModel } = await import('@/lib/server/assistant/model');
    const gathered: GatheredWork = {
      own: [{ id: '1', sourceId: 'a', source: 'github', kind: 'work.pr_merged', title: 'Add invoice retries', repo: 'acme/billing', at: '2026-11-13T10:00:00Z', visibility: 'private' }],
      related: [{ person: { name: 'Ben' }, items: [{ id: '2', sourceId: 'b', source: 'github', kind: 'work.pr_merged', title: 'Invoice export', repo: 'acme/billing', at: '2026-11-13T12:00:00Z', visibility: 'team' }], because: { type: 'repo', name: 'acme/billing' } }],
      finished: [],
    };
    const result = await writeBriefingText(gathered, assistantModel(chatModel));
    expect(result.model).toBe(`ollama/${chatModel}`);
    expect(result.text.length).toBeGreaterThan(20);
    expect(result.text.length).toBeLessThanOrEqual(1200);
  });
});
