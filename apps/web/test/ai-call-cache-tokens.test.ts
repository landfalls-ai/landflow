/** The `ai.call` usage event carries the prompt-cache counts next to input and output (for ledgers that price them apart). */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const previousDir = process.env.LANDFLOW_DATA_DIR;
process.env.LANDFLOW_DATA_DIR = mkdtempSync(join(tmpdir(), 'landflow-ai-call-cache-'));
afterAll(() => {
  process.env.LANDFLOW_DATA_DIR = previousDir;
});

const { aiUsageMeter, UsageScope } = await import('@/lib/server/ai-usage');
const { listUsageEvents } = await import('@/lib/server/usage/query');

describe('ai.call usage events', () => {
  it('carry cacheRead and cacheWrite, and 0 when the provider reports none', () => {
    const scope = new UsageScope({ surface: 'spotlight', userId: 'usr_cache_test' });
    const meter = aiUsageMeter();
    meter.record({ provider: 'anthropic', model: 'claude-sonnet-5-5', operation: 'chat', inputTokens: 1340, outputTokens: 50, cacheReadTokens: 1200, cacheWriteTokens: 100, cost: 0.002 }, scope);
    meter.record({ provider: 'ollama', model: 'qwen3-coder:30b', operation: 'chat', inputTokens: 80, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 }, scope);
    const events = listUsageEvents({ kinds: ['ai.call'] }, { limit: 10 });
    const byModel = Object.fromEntries(events.map((e) => [e.attrs?.model, e.attrs]));
    expect(byModel['claude-sonnet-5-5']).toMatchObject({ input: 1340, output: 50, cacheRead: 1200, cacheWrite: 100 });
    expect(byModel['qwen3-coder:30b']).toMatchObject({ input: 80, output: 20, cacheRead: 0, cacheWrite: 0 });
  });
});
