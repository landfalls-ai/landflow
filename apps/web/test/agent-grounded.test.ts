/** The output guardrail's grounded check in a running agent: the passages its knowledge base returned reach the judge, with the answer. */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, LanguageModel, ModelTurn, ToolSpec } from '@landflow/engine';
import type { AgentGuardrail } from '@/lib/shared/agents';
import { MemoryVectorStore } from '@/lib/server/rag/stores';

type Step = (input: { system?: string; messages: AgentMessage[]; tools: ToolSpec[] }) => Partial<ModelTurn>;
const script: Step[] = [];
const seen: Array<{ system?: string; messages: AgentMessage[] }> = [];

vi.mock('@/lib/server/agents/models', () => ({
  OLLAMA_URL: 'http://127.0.0.1:11434',
  modelOptions: async () => [],
  agentModel: (config: { model?: string } | undefined): LanguageModel => {
    if (!config?.model) throw new Error('Choose a model for this agent first');
    return {
      provider: 'scripted',
      model: config.model,
      async generate(input) {
        seen.push({ system: input.system, messages: structuredClone(input.messages) });
        const step = script.shift();
        if (!step) throw new Error('The script ran out of turns');
        return { text: '', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 }, ...step(input) };
      },
    };
  },
}));

const { agentStore } = await import('@/lib/server/agents/store');
const { newSession, runAgent } = await import('@/lib/server/agents/runtime');

let base = '';
let close = () => {};
beforeAll(async () => {
  // Every text embeds to the same vector, so a search returns whatever the collection holds.
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: body.model, embeddings: body.input.map(() => [1, 0, 0, 0]) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
  const store = new MemoryVectorStore();
  await store.clear('grounded_test');
  await store.add('grounded_test', [{ pageContent: 'Refunds: up to $50 for a damaged parcel.', metadata: { title: 'Refunds' }, embedding: [1, 0, 0, 0] }]);
});
afterAll(() => close());
beforeEach(() => {
  script.length = 0;
  seen.length = 0;
});

const rule = (patch: Partial<AgentGuardrail>): AgentGuardrail => ({ enabled: true, action: 'block', reply: 'I could not verify that against our documents.', checks: {}, ...patch });
const makeAgent = () =>
  agentStore.create({
    name: 'Grounded',
    instructions: 'Answer from the documents.',
    model: { provider: 'ollama', model: 'scripted-1' },
    guardrails: { output: rule({ checks: { grounded: {} } }) },
    tools: [{ id: 'k1', type: 'knowledge', name: 'search_docs', description: 'The documents', store: 'memory', collection: 'grounded_test', embeddings: { provider: 'ollama', model: 'fake-embed', baseUrl: base }, topK: 1 }],
  });
const search: Step = () => ({ toolCalls: [{ id: 'c1', name: 'search_docs', input: { query: 'refund limit' } }] });
const start = (message: string) => {
  const agent = makeAgent();
  return runAgent({ agent, session: newSession(agent, { source: 'test', userId: 'you', version: 'draft' }), message });
};

describe('the grounded check in an agent with a knowledge base', () => {
  it('shows the judge what the search returned and withholds an answer it flags', async () => {
    script.push(search, () => ({ text: 'The refund limit is $500.' }), () => ({ text: '{"flagged":true,"confidence":0.9,"reason":"the passages say $50, not $500"}' }));
    const result = await start('What is the refund limit for a damaged parcel?');
    expect(result.reply).toBe('I could not verify that against our documents.');
    // The third model call is the judge: it got the retrieved passage and the answer.
    const judged = JSON.stringify(seen[2].messages);
    expect(judged).toContain('up to $50 for a damaged parcel');
    expect(judged).toContain('The refund limit is $500.');
    const entry = agentStore.getSession(result.session.id)!.timeline.find((e) => e.type === 'guardrail');
    expect(entry).toMatchObject({ stage: 'output', action: 'blocked', violations: [{ check: 'grounded', reason: 'the passages say $50, not $500' }] });
  });

  it('lets a supported answer through', async () => {
    script.push(search, () => ({ text: 'Up to $50 for a damaged parcel.' }), () => ({ text: '{"flagged":false,"confidence":0.05}' }));
    const result = await start('What is the refund limit for a damaged parcel?');
    expect(result.reply).toBe('Up to $50 for a damaged parcel.');
    expect(agentStore.getSession(result.session.id)!.timeline.some((e) => e.type === 'guardrail')).toBe(false);
  });
});
