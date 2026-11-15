/**
 * The `ai.call` usage event keeps the keys the ledgers read, with the meaning they have today, and grows only by the
 * keys of `AiCallEventAttribution` (lib/shared/ai-call.ts, wave 11).
 *
 * Landledger parses this event (read-only, /Users/pickjonathan/WorkSpace/landledger):
 *   libs/contracts/src/sources.ts 25-50 (`LandflowAiEvent`: `attrs` is loose; reads provider, model, operation, input,
 *   output, cacheRead, cacheWrite) and apps/api/src/ingest/build.ts 179-188 (`input` is the whole prompt, the cache
 *   counts are parts of it). The keys below are literals on purpose: renaming one must fail here before it breaks a ledger.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const previousDir = process.env.LANDFLOW_DATA_DIR;
process.env.LANDFLOW_DATA_DIR = mkdtempSync(join(tmpdir(), 'landflow-ai-ledger-keys-'));
afterAll(() => {
  process.env.LANDFLOW_DATA_DIR = previousDir;
});

const { aiUsageMeter, UsageScope } = await import('@/lib/server/ai-usage');
const { listUsageEvents } = await import('@/lib/server/usage/query');

/** What Landledger reads, with today's meaning. */
const LEDGER_KEYS = ['provider', 'model', 'operation', 'input', 'output', 'cacheRead', 'cacheWrite'];
/** Keys that exist today next to them, set only when known. */
const EXISTING_OPTIONAL = ['callId', 'requestId', 'source', 'gatewayCost'];
/** The keys wave 11 adds (`AiCallEventAttribution`), each only when set. */
const ATTRIBUTION_KEYS = ['purpose', 'nodeId', 'sessionId', 'iteration', 'usageId'];

describe('the ai.call ledger event', () => {
  it('carries the keys the ledgers read, and grows only by the attribution keys', () => {
    const scope = new UsageScope({ surface: 'spotlight', userId: 'usr_ledger_keys' });
    aiUsageMeter().record(
      { provider: 'anthropic', model: 'claude-sonnet-5-5', operation: 'chat', inputTokens: 1340, outputTokens: 50, cacheReadTokens: 1200, cacheWriteTokens: 100, cost: 0.002 },
      scope,
    );
    const [event] = listUsageEvents({ kinds: ['ai.call'] }, { limit: 1 });
    expect(event.kind).toBe('ai.call');
    const attrs = event.attrs ?? {};
    expect(attrs).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5', operation: 'chat', input: 1340, output: 50, cacheRead: 1200, cacheWrite: 100 });
    // `input` is the whole prompt, cached tokens included: the cache counts are parts of it, never above it.
    expect(attrs.cacheRead + attrs.cacheWrite).toBeLessThanOrEqual(attrs.input);
    for (const key of Object.keys(attrs)) expect([...LEDGER_KEYS, ...EXISTING_OPTIONAL, ...ATTRIBUTION_KEYS], key).toContain(key);
  });
});
