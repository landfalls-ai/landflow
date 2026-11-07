import { describe, expect, it, vi } from 'vitest';
import type { LanguageModel } from '@landflow/engine';
import { chooseTier, cleanRouter, type AgentRouter } from '@/lib/shared/agent-router';

/** Which model answered each turn. */
const answered: string[] = [];

vi.mock('@/lib/server/agents/models', () => ({
  OLLAMA_URL: 'http://127.0.0.1:11434',
  modelOptions: async () => [],
  agentModel: (config: { model?: string } | undefined): LanguageModel => {
    if (!config?.model) throw new Error('Choose a model for this agent first');
    return {
      provider: 'scripted',
      model: config.model,
      async generate() {
        answered.push(config.model!);
        return { text: `from ${config.model}`, toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
  },
}));

const { store } = await import('@/lib/server/store');
const { agentStore } = await import('@/lib/server/agents/store');
const { newSession, runAgent } = await import('@/lib/server/agents/runtime');

void store;

const auto: AgentRouter = { mode: 'auto', cheapModel: { provider: 'ollama', model: 'small-1' }, maxChars: 100, allowTools: false };

describe('chooseTier', () => {
  it('sends short requests to the cheap model and keeps everything else on the agent’s own', () => {
    expect(chooseTier(auto, { message: 'What are your hours?', toolCount: 0 }).tier).toBe('cheap');
    expect(chooseTier(auto, { message: 'x'.repeat(101), toolCount: 0 })).toMatchObject({ tier: 'strong', reason: expect.stringMatching(/longer than 100/) });
    expect(chooseTier(auto, { message: 'Hi', toolCount: 2 })).toMatchObject({ tier: 'strong', reason: 'the agent has tools' });
    expect(chooseTier({ ...auto, allowTools: true }, { message: 'Hi', toolCount: 2 }).tier).toBe('cheap');
    expect(chooseTier(auto, { toolCount: 0 })).toMatchObject({ tier: 'strong', reason: 'resuming a run' });
    expect(chooseTier({ ...auto, mode: 'fixed' }, { message: 'Hi', toolCount: 0 }).tier).toBe('strong');
    expect(chooseTier(undefined, { message: 'Hi', toolCount: 0 }).tier).toBe('strong');
    expect(chooseTier({ ...auto, cheapModel: undefined }, { message: 'Hi', toolCount: 0 }).reason).toBe('no cheap model chosen');
  });

  it('cleans a router: nothing to keep when it is fixed with no cheap model, limits clamped', () => {
    expect(cleanRouter(undefined)).toBeUndefined();
    expect(cleanRouter({ mode: 'fixed' })).toBeUndefined();
    expect(cleanRouter({ mode: 'auto', cheapModel: { provider: 'ollama', model: 'small-1' }, maxChars: 5 })).toMatchObject({ mode: 'auto', maxChars: 20, allowTools: false });
    expect(cleanRouter({ mode: 'auto', maxChars: 999_999 })?.maxChars).toBe(20_000);
  });
});

describe('the router in a run', () => {
  const makeAgent = (router?: AgentRouter) => agentStore.create({ name: 'Front desk', instructions: 'Be brief.', model: { provider: 'ollama', model: 'big-1' }, ...(router && { router }) });
  const ask = async (agent: ReturnType<typeof makeAgent>, message: string) => {
    const session = newSession(agent, { source: 'test', userId: 'u1', version: 'draft' });
    return runAgent({ agent, session, message });
  };

  it('answers an easy request with the cheap model and says so in the session', async () => {
    answered.length = 0;
    const result = await ask(makeAgent(auto), 'What are your hours?');
    expect(answered).toEqual(['small-1']);
    expect(result.session.timeline.some((e) => e.type === 'notice' && /Routed to small-1/.test(e.message))).toBe(true);
  });

  it('keeps a long request on the agent’s own model, and an agent without a router unchanged', async () => {
    answered.length = 0;
    await ask(makeAgent(auto), 'y'.repeat(300));
    await ask(makeAgent(), 'Hi');
    expect(answered).toEqual(['big-1', 'big-1']);
  });
});
