import { describe, expect, it, vi } from 'vitest';
import type { LanguageModel } from '@landflow/engine';
import { cleanCache, normalizeQuestion, uncacheable } from '@/lib/shared/agent-cache';

/** How many times a model was asked. */
let calls = 0;

vi.mock('@/lib/server/agents/models', () => ({
  OLLAMA_URL: 'http://127.0.0.1:11434',
  modelOptions: async () => [],
  agentModel: (config: { model?: string } | undefined): LanguageModel => {
    if (!config?.model) throw new Error('Choose a model for this agent first');
    return {
      provider: 'scripted',
      model: config.model,
      async generate() {
        calls += 1;
        return { text: `answer ${calls}`, toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
  },
}));

const { store } = await import('@/lib/server/store');
const { agentStore } = await import('@/lib/server/agents/store');
const { newSession, runAgent } = await import('@/lib/server/agents/runtime');
const { responseCache, cacheKey } = await import('@/lib/server/agents/response-cache');
const { configOf } = await import('@/lib/server/agents/store');

void store;

const make = (config: Record<string, unknown> = {}) =>
  agentStore.create({ name: 'FAQ', instructions: 'Answer briefly.', model: { provider: 'ollama', model: 'm-1' }, cache: { enabled: true, ttlSeconds: 3_600 }, ...config });
const ask = (agent: ReturnType<typeof make>, message: string) => runAgent({ agent, session: newSession(agent, { source: 'test', userId: 'u1', version: 'draft' }), message });

describe('the cache rules', () => {
  it('keeps nothing when off, clamps the TTL, and ignores case and spacing in a question', () => {
    expect(cleanCache(undefined)).toBeUndefined();
    expect(cleanCache({ enabled: false, ttlSeconds: 99 })).toBeUndefined();
    expect(cleanCache({ enabled: true, ttlSeconds: 1 })).toEqual({ enabled: true, ttlSeconds: 10 });
    expect(cleanCache({ enabled: true, ttlSeconds: 1e12 })?.ttlSeconds).toBe(30 * 86_400);
    expect(normalizeQuestion('  What   ARE your hours? ')).toBe('what are your hours?');
  });

  it('says why a run cannot use it', () => {
    const ok = { cache: { enabled: true, ttlSeconds: 60 }, messageCount: 1, toolCount: 0, memory: false, borrowed: false };
    expect(uncacheable(ok)).toBeUndefined();
    expect(uncacheable({ ...ok, cache: undefined })).toMatch(/off/);
    expect(uncacheable({ ...ok, messageCount: 3 })).toMatch(/first message/);
    expect(uncacheable({ ...ok, toolCount: 1 })).toMatch(/tools/);
    expect(uncacheable({ ...ok, memory: true })).toMatch(/memory/);
    expect(uncacheable({ ...ok, borrowed: true })).toMatch(/workflow or team/);
  });
});

describe('the response cache in a run', () => {
  it('answers a repeated question from the cache with no second model call, ignoring case and spacing', async () => {
    const agent = make();
    calls = 0;
    const first = await ask(agent, 'What are your hours?');
    const second = await ask(agent, '  what ARE   your hours? ');
    expect(first.reply).toBe('answer 1');
    expect(second.reply).toBe('answer 1');
    expect(calls).toBe(1);
    expect(second.session.timeline.some((e) => e.type === 'notice' && /response cache/.test(e.message))).toBe(true);
    expect(responseCache.stats(agent.id)).toEqual({ entries: 1, hits: 1 });
  });

  it('starts fresh when the prompt changes, keeps agents apart, and forgets on clear', async () => {
    const agent = make();
    calls = 0;
    await ask(agent, 'Hello');
    const edited = agentStore.saveDraft(agent.id, { instructions: 'Answer in French.' })!;
    expect((await ask(edited, 'Hello')).reply).toBe('answer 2');
    const other = make();
    expect((await ask(other, 'Hello')).reply).toBe('answer 3');
    expect(responseCache.clear(agent.id)).toBe(2);
    expect((await ask(agentStore.get(agent.id)!, 'Hello')).reply).toBe('answer 4');
    expect(cacheKey(agent.id, configOf(agent), 'Hello')).not.toBe(cacheKey(agent.id, configOf(edited), 'Hello'));
  });

  it('never caches a run that is off, has memory, or is not the first message', async () => {
    calls = 0;
    const off = make({ cache: undefined });
    await ask(off, 'Hi');
    await ask(off, 'Hi');
    const memory = make({ memory: { crossSession: true } });
    await ask(memory, 'Hi');
    await ask(memory, 'Hi');
    expect(calls).toBe(4);

    const agent = make();
    const session = newSession(agent, { source: 'test', userId: 'u1', version: 'draft' });
    await runAgent({ agent, session, message: 'One' });
    const before = calls;
    await runAgent({ agent, session, message: 'One' });
    expect(calls).toBe(before + 1);
  });

  it('does not store an answer the router\'s cheap model gave, or one an evaluation run asked for', async () => {
    calls = 0;
    const routed = make({ router: { mode: 'auto', maxChars: 400, allowTools: false, cheapModel: { provider: 'ollama', model: 'small' } } });
    await ask(routed, 'Short question');
    await ask(routed, 'Short question');
    expect(calls).toBe(2);
    expect(responseCache.stats(routed.id).entries).toBe(0);

    const agent = make();
    const evaluation = () => runAgent({ agent, session: newSession(agent, { source: 'test', userId: 'evaluation', version: 'draft' }), message: 'Same question' });
    calls = 0;
    await evaluation();
    await evaluation();
    expect(calls).toBe(2);
    expect(responseCache.stats(agent.id).entries).toBe(0);
  });

  it('drops an answer once it has expired', async () => {
    const agent = make();
    const key = cacheKey(agent.id, configOf(agent), 'Old question');
    responseCache.set(agent.id, key, 'stale', 1);
    expect(responseCache.get(key)).toBe('stale');
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5_000);
    try {
      expect(responseCache.get(key)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
