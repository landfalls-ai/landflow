import { describe, expect, it, vi } from 'vitest';
import type { LanguageModel } from '@landflow/engine';
import { cleanCache, cosine, SEMANTIC_THRESHOLD_MAX, SEMANTIC_THRESHOLD_MIN } from '@/lib/shared/agent-cache';

let calls = 0;
let embeddingDown = false;

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

/** Questions about opening times point one way, refunds another. */
vi.mock('@/lib/server/rag/embeddings', () => ({
  ollamaEmbeddings: () => ({
    provider: 'ollama',
    model: 'stub',
    embedDocuments: async (texts: string[]) => texts.map(() => [1, 0]),
    embedQuery: async (text: string) => {
      if (embeddingDown) throw new Error('Cannot reach Ollama');
      return /hours|open/.test(text) ? [1, 0.05] : [0.05, 1];
    },
  }),
  openAiCompatibleEmbeddings: () => undefined,
}));

const { store } = await import('@/lib/server/store');
const { agentStore } = await import('@/lib/server/agents/store');
const { newSession, runAgent } = await import('@/lib/server/agents/runtime');
const { semanticCache, configHash } = await import('@/lib/server/agents/semantic-cache');
const { configOf } = await import('@/lib/server/agents/store');

void store;

const make = () =>
  agentStore.create({
    name: 'FAQ',
    instructions: 'Answer briefly.',
    model: { provider: 'ollama', model: 'm-1' },
    cache: { enabled: true, ttlSeconds: 3_600, semantic: { enabled: true, threshold: 0.9, model: 'stub' } },
  });
const ask = (agent: ReturnType<typeof make>, message: string) => {
  const session = newSession(agent, { source: 'test', userId: 'u1', version: 'draft' });
  return runAgent({ agent, session, message }).then((result) => ({ result, session }));
};
const notices = (session: Awaited<ReturnType<typeof ask>>['session']) => session.timeline.filter((e) => e.type === 'notice').map((e) => (e as { message: string }).message);

describe('the semantic rules', () => {
  it('measures how alike two vectors are', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([1, 0], [1])).toBe(0);
    expect(cosine([0, 0], [1, 0])).toBe(0);
  });

  it('keeps it only while on, and clamps the threshold', () => {
    expect(cleanCache({ enabled: true, ttlSeconds: 60, semantic: { enabled: false, threshold: 0.9, model: 'x' } })?.semantic).toBeUndefined();
    expect(cleanCache({ enabled: true, ttlSeconds: 60, semantic: { enabled: true, threshold: 0.1, model: ' ' } })?.semantic).toEqual({ enabled: true, threshold: SEMANTIC_THRESHOLD_MIN, model: 'nomic-embed-text' });
    expect(cleanCache({ enabled: true, ttlSeconds: 60, semantic: { enabled: true, threshold: 5, model: 'm', baseUrl: ' http://x ' } })?.semantic).toMatchObject({ threshold: SEMANTIC_THRESHOLD_MAX, baseUrl: 'http://x' });
  });
});

describe('the semantic cache in a run', () => {
  it('answers a differently worded question from the cache, and a different question from the model', async () => {
    const agent = make();
    calls = 0;
    const first = await ask(agent, 'What are your hours?');
    expect(first.result.reply).toBe('answer 1');

    const similar = await ask(agent, 'When are you open?');
    expect(similar.result.reply).toBe('answer 1');
    expect(calls).toBe(1);
    expect(notices(similar.session).join(' ')).toMatch(/similar to "What are your hours\?"/);
    expect(semanticCache.stats(agent.id)).toEqual({ entries: 1, hits: 1 });

    const other = await ask(agent, 'How do I get a refund?');
    expect(other.result.reply).toBe('answer 2');
    expect(calls).toBe(2);
  });

  it('starts fresh when the agent is edited, and can be cleared', async () => {
    const agent = make();
    calls = 0;
    await ask(agent, 'What are your hours?');
    const before = configHash(agent.id, configOf(agent));
    const edited = agentStore.saveDraft(agent.id, { ...configOf(agent), instructions: 'Answer in French.' })!;
    expect(configHash(agent.id, configOf(edited))).not.toBe(before);
    const again = await ask(edited, 'When are you open?');
    expect(again.result.reply).toBe('answer 2');
    expect(semanticCache.clear(agent.id)).toBe(2);
  });

  it('runs the model as usual when the embedding model cannot be reached', async () => {
    const agent = make();
    calls = 0;
    embeddingDown = true;
    try {
      const run = await ask(agent, 'What are your hours?');
      expect(run.result.reply).toBe('answer 1');
      expect(notices(run.session).join(' ')).toMatch(/Similar-question cache skipped: Cannot reach Ollama/);
      expect(semanticCache.stats(agent.id).entries).toBe(0);
    } finally {
      embeddingDown = false;
    }
  });
});
