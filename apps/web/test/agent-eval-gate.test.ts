import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { LanguageModel } from '@landflow/engine';

/** The score the scripted judge gives; the agent always answers "42". */
let judgeScore = 5;

vi.mock('@/lib/server/agents/models', () => ({
  OLLAMA_URL: 'http://127.0.0.1:11434',
  modelOptions: async () => [],
  agentModel: (config: { model?: string } | undefined): LanguageModel => {
    if (!config?.model) throw new Error('Choose a model for this agent first');
    return {
      provider: 'scripted',
      model: config.model,
      async generate(input) {
        const judging = (input.system ?? '').includes('"score"');
        return {
          text: judging ? JSON.stringify({ score: judgeScore, reasoning: 'scripted' }) : '42',
          toolCalls: [],
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    };
  },
}));

const { store } = await import('@/lib/server/store');
const { agentStore } = await import('@/lib/server/agents/store');
const { addCase, baselineOf, checkPublish, deleteCase, listCases, listEvalRuns, runEval, adoptRun } = await import('@/lib/server/agents/eval-gate');
const { gateVerdict } = await import('@/lib/shared/agent-eval');

beforeAll(() => {
  void store;
});

const makeAgent = () => agentStore.create({ name: 'Maths', instructions: 'Answer briefly.', model: { provider: 'ollama', model: 'scripted-1' } });

describe('gateVerdict', () => {
  it('holds a low average, or a drop of more than half a point', () => {
    expect(gateVerdict(4.5).ok).toBe(true);
    expect(gateVerdict(2.5).ok).toBe(false);
    expect(gateVerdict(4, 4.4).ok).toBe(true);
    expect(gateVerdict(3.8, 4.5)).toMatchObject({ ok: false, baseline: 4.5 });
  });
});

describe('agent eval gate', () => {
  it('keeps test cases per agent', () => {
    const agent = makeAgent();
    const a = addCase(agent.id, { input: ' What is 6 x 7? ', expected: '42' });
    expect(a.input).toBe('What is 6 x 7?');
    expect(() => addCase(agent.id, { input: '  ' })).toThrow(/question/);
    expect(listCases(agent.id)).toHaveLength(1);
    expect(listCases(makeAgent().id)).toHaveLength(0);
    expect(deleteCase(agent.id, a.id)).toBe(true);
    expect(listCases(agent.id)).toHaveLength(0);
  });

  it('runs the cases, scores them, and leaves no sessions behind', async () => {
    const agent = makeAgent();
    addCase(agent.id, { input: 'What is 6 x 7?', expected: '42' });
    addCase(agent.id, { input: 'Say hi' });
    judgeScore = 4;
    const run = await runEval(agent.id);
    expect(run).toMatchObject({ version: 'draft', average: 4 });
    expect(run.results.map((r) => r.reply)).toEqual(['42', '42']);
    expect(listEvalRuns(agent.id)).toHaveLength(1);
    expect(agentStore.listSessions(agent.id)).toHaveLength(0);
  });

  it('lets an agent without cases publish, and holds a draft that drops below the published version', async () => {
    const agent = makeAgent();
    expect(await checkPublish(agent.id)).toMatchObject({ skipped: true, verdict: { ok: true } });

    addCase(agent.id, { input: 'What is 6 x 7?', expected: '42' });
    judgeScore = 5;
    const first = await checkPublish(agent.id);
    expect(first.verdict).toMatchObject({ ok: true, average: 5 });
    const published = agentStore.publish(agent.id)!;
    adoptRun(first.run!, published.published!.version);
    expect(baselineOf(agent.id, 1)).toBe(5);

    agentStore.saveDraft(agent.id, { instructions: 'Answer with nonsense.' });
    judgeScore = 3;
    const second = await checkPublish(agent.id);
    expect(second.verdict).toMatchObject({ ok: false, baseline: 5, average: 3 });
    expect(second.verdict.reason).toMatch(/below the published/);
  });

  it('can run a published version, and refuses one that is not in the history', async () => {
    const agent = makeAgent();
    addCase(agent.id, { input: 'Hello' });
    agentStore.publish(agent.id);
    judgeScore = 5;
    expect((await runEval(agent.id, 1)).version).toBe(1);
    await expect(runEval(agent.id, 9)).rejects.toThrow(/not in the history/);
  });
});
